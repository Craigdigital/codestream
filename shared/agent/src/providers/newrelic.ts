"use strict";
import { GraphQLClient } from "graphql-request";
import { ResponseError } from "vscode-jsonrpc/lib/messages";
import { InternalError, ReportSuppressedMessages } from "../agentError";
import { SessionContainer } from "../container";
import { Logger } from "../logger";
import {
	EntityAccount,
	ERROR_NR_CONNECTION_INVALID_API_KEY,
	ERROR_NR_CONNECTION_MISSING_API_KEY,
	ERROR_NR_CONNECTION_MISSING_URL,
	ErrorGroupResponse,
	ErrorGroupsResponse,
	GetNewRelicAccountsRequestType,
	GetNewRelicAccountsResponse,
	GetNewRelicAssigneesRequestType,
	GetNewRelicErrorGroupRequest,
	GetNewRelicErrorGroupRequestType,
	GetNewRelicErrorGroupResponse,
	GetObservabilityEntitiesRequest,
	GetObservabilityErrorAssignmentsRequest,
	GetObservabilityErrorAssignmentsRequestType,
	GetObservabilityErrorAssignmentsResponse,
	GetObservabilityErrorGroupMetadataRequest,
	GetObservabilityErrorGroupMetadataRequestType,
	GetObservabilityErrorGroupMetadataResponse,
	GetObservabilityErrorsRequest,
	GetObservabilityErrorsRequestType,
	GetObservabilityErrorsResponse,
	GetObservabilityReposRequest,
	GetObservabilityReposRequestType,
	GetObservabilityReposResponse,
	NewRelicConfigurationData,
	NewRelicErrorGroup,
	ObservabilityError,
	ObservabilityErrorCore,
	RelatedEntity,
	ThirdPartyDisconnect,
	ThirdPartyProviderConfig,
	StackTraceResponse,
	EntitySearchResponse,
	GetObservabilityEntitiesResponse,
	GetObservabilityEntitiesRequestType,
	ReposScm
} from "../protocol/agent.protocol";
import { CSNewRelicProviderInfo } from "../protocol/api.protocol";
import { CodeStreamSession } from "../session";
import { log, lspHandler, lspProvider } from "../system";
import { Strings } from "../system/string";
import { ThirdPartyIssueProviderBase } from "./provider";
import { memoize, groupBy as _groupBy, sortBy as _sortBy } from "lodash-es";
import { GitRemoteParser } from "../git/parsers/remoteParser";

export interface Directive {
	type: "assignRepository" | "removeAssignee" | "setAssignee" | "setState";
	data: any;
}

interface Directives {
	directives: Directive[];
}

interface NewRelicId {
	accountId: number;
	unknownAbbreviation: string;
	entityType: string;
	unknownGuid: string;
}

interface NewRelicEntity {
	guid: string;
	name: string;
	tags: { key: string; values: string[] }[];
	type: string;
}

const MetricsLookupBackoffs = [
	{
		// short lived data lives in MetricRaw
		table: "MetricRaw",
		since: "10 minutes"
	},
	{
		table: "Metric",
		since: "3 day"
	},
	{
		table: "Metric",
		since: "7 day"
	}
];

class AccessTokenError extends Error {
	constructor(public text: string, public innerError: any, public isAccessTokenError: boolean) {
		super(text);
	}
}

@lspProvider("newrelic")
export class NewRelicProvider extends ThirdPartyIssueProviderBase<CSNewRelicProviderInfo> {
	private _newRelicUserId: number | undefined = undefined;
	private _memoizedGetRepoRemoteVariants: any;

	constructor(session: CodeStreamSession, config: ThirdPartyProviderConfig) {
		super(session, config);
		this._memoizedGetRepoRemoteVariants = memoize(
			this.getRepoRemoteVariants,
			(remotes: string[]) => remotes
		);
	}

	get displayName() {
		return "New Relic";
	}

	get name() {
		return "newrelic";
	}

	get headers() {
		return {
			"Api-Key": this.accessToken!,
			"Content-Type": "application/json"
		};
	}

	get apiUrl() {
		const data = this._providerInfo && this._providerInfo.data;
		return this.getApiUrlCore(data);
	}

	private getApiUrlCore(data?: { apiUrl?: string; usingEU?: boolean; [key: string]: any }): string {
		if (data) {
			if (data.apiUrl) {
				return Strings.trimEnd(data.apiUrl, "/").toLowerCase();
			}
			if (data.usingEU) {
				return "https://api.eu.newrelic.com";
			}
		}
		return "https://api.newrelic.com";
	}

	get productUrl() {
		return this.apiUrl.replace("api", "one");
	}

	get baseUrl() {
		return this.apiUrl;
	}

	get graphQlBaseUrl() {
		return `${this.baseUrl}/graphql`;
	}

	@log()
	async onDisconnected(request?: ThirdPartyDisconnect) {
		// delete the graphql client so it will be reconstructed if a new token is applied
		delete this._client;
		delete this._newRelicUserId;
		super.onDisconnected(request);
	}

	protected async client(): Promise<GraphQLClient> {
		const client =
			this._client || (this._client = this.createClient(this.graphQlBaseUrl, this.accessToken));
		client.setHeaders({
			"Api-Key": this.accessToken!,
			"Content-Type": "application/json",
			"NewRelic-Requesting-Services": "CodeStream"
		});
		return client;
	}

	protected createClient(graphQlBaseUrl?: string, accessToken?: string): GraphQLClient {
		if (!graphQlBaseUrl) {
			throw new ResponseError(ERROR_NR_CONNECTION_MISSING_URL, "Could not get a New Relic API URL");
		}
		if (!accessToken) {
			throw new ResponseError(
				ERROR_NR_CONNECTION_MISSING_API_KEY,
				"Could not get a New Relic API key"
			);
		}
		const options: { [key: string]: any } = {};
		if (this._httpsAgent) {
			options.agent = this._httpsAgent;
		}
		const client = new GraphQLClient(graphQlBaseUrl, options);

		// set accessToken on a per-usage basis... possible for accessToken
		// to be revoked from the source (github.com) and a stale accessToken
		// could be cached in the _client instance.
		client.setHeaders({
			"Api-Key": accessToken!,
			"Content-Type": "application/json",
			"NewRelic-Requesting-Services": "CodeStream"
		});

		return client;
	}

	@log()
	async configure(request: NewRelicConfigurationData) {
		// FIXME - this rather sucks as a way to ensure we have the access token
		// const userPromise = new Promise<void>(resolve => {
		// 	this.session.api.onDidReceiveMessage(e => {
		// 		if (e.type !== MessageType.Users) return;
		//
		// 		const me = e.data.find((u: any) => u.id === this.session.userId) as CSMe | null | undefined;
		// 		if (me == null) return;
		//
		// 		const providerInfo = this.getProviderInfo(me);
		// 		if (providerInfo == null || !providerInfo.accessToken) return;
		//
		// 		resolve();
		// 	});
		// });
		const client = this.createClient(
			this.getApiUrlCore({ apiUrl: request.apiUrl }) + "/graphql",
			request.apiKey
		);
		const { userId, accounts } = await this.validateApiKey(client);
		await this.session.api.setThirdPartyProviderToken({
			providerId: this.providerConfig.id,
			token: request.apiKey,
			data: {
				userId,
				accountId: request.accountId,
				apiUrl: request.apiUrl
			}
		});
	}

	private async validateApiKey(
		client: GraphQLClient
	): Promise<{
		userId: number;
		organizationId?: number;
		accounts: any[];
	}> {
		try {
			const response = await client.request<{
				actor: {
					user: {
						id: number;
					};
					organization?: {
						id: number;
					};
					accounts: [
						{
							id: number;
							name: string;
						}
					];
				};
			}>(`{
				actor {
					user {
						id
					}
					accounts {
						id,
						name
					}
				}
			}`);
			return {
				userId: response.actor.user.id,
				accounts: response.actor.accounts,
				organizationId: response.actor.organization?.id
			};
		} catch (ex) {
			const accessTokenError = this.getAccessTokenError(ex);
			throw new ResponseError(
				ERROR_NR_CONNECTION_INVALID_API_KEY,
				accessTokenError?.message || ex.message || ex.toString()
			);
		}
	}

	async mutate<T>(query: string, variables: any = undefined) {
		await this.ensureConnected();

		return (await this.client()).request<T>(query, variables);
	}

	async query<T = any>(query: string, variables: any = undefined): Promise<T> {
		await this.ensureConnected();

		if (this._providerInfo && this._providerInfo.tokenError) {
			delete this._client;
			throw new InternalError(ReportSuppressedMessages.AccessTokenInvalid);
		}

		let response: any;
		try {
			response = await (await this.client()).request<T>(query, variables);
		} catch (ex) {
			Logger.warn(`NR: query caught:`, ex);
			const exType = this._isSuppressedException(ex);
			if (exType !== undefined) {
				// this throws the error but won't log to sentry (for ordinary network errors that seem temporary)
				throw new InternalError(exType, { error: ex });
			} else {
				const accessTokenError = this.getAccessTokenError(ex);
				if (accessTokenError) {
					throw new AccessTokenError(accessTokenError.message, ex, true);
				}

				// this is an unexpected error, throw the exception normally
				throw ex;
			}
		}

		return response;
	}

	private getAccessTokenError(ex: any): { message: string } | undefined {
		let requestError = ex as {
			response: {
				errors: {
					extensions: {
						error_code: string;
					};
					message: string;
				}[];
			};
		};
		if (
			requestError &&
			requestError.response &&
			requestError.response.errors &&
			requestError.response.errors.length
		) {
			return requestError.response.errors.find(
				_ => _.extensions && _.extensions.error_code === "BAD_API_KEY"
			);
		}
		return undefined;
	}

	private _applicationEntitiesCache: GetObservabilityEntitiesResponse | undefined = undefined;

	@lspHandler(GetObservabilityEntitiesRequestType)
	@log({
		timed: true
	})
	async getEntities(
		request: GetObservabilityEntitiesRequest
	): Promise<GetObservabilityEntitiesResponse> {
		try {
			if (this._applicationEntitiesCache != null) {
				Logger.debug("NR: query entities (from cache)");
				return this._applicationEntitiesCache;
			}

			let results: any[] = [];
			let nextCursor: any = undefined;
			// let i = 0;
			//	while (true) {

			if (request.appName != null) {
				// try to find the entity based on the app / remote name
				const response = await this.query<any>(
					`query  {
				actor {
				  entitySearch(query: "type='APPLICATION' and name LIKE '${Strings.sanitizeGraphqlValue(
						request.appName
					)}'", sortBy:MOST_RELEVANT) { 
					results {			 
					  entities {					
						guid
						name
					  }
					}
				  }
				}
			  }`
				);

				results = results.concat(
					response.actor.entitySearch.results.entities.map((_: any) => {
						return {
							guid: _.guid,
							name: _.name
						};
					})
				);
			}

			const response = await this.query<any>(
				`query search($cursor:String) {
			actor {
			  entitySearch(query: "type='APPLICATION'", sortBy:MOST_RELEVANT) { 
				results(cursor:$cursor) {
				 nextCursor
				  entities {					
					guid
					name
				  }
				}
			  }
			}
		  }`,
				{
					cursor: nextCursor
				}
			);

			results = results.concat(
				response.actor.entitySearch.results.entities.map((_: any) => {
					return {
						guid: _.guid,
						name: _.name
					};
				})
			);
			// nextCursor = response.actor.entitySearch.results.nextCursor;
			// i++;
			// if (!nextCursor) {
			// 	break;
			// } else {
			// 	Logger.log("NR: query entities ", {
			// 		i: i
			// 	});
			// }
			//	}
			results.sort((a, b) => a.name.localeCompare(b.name));

			results = [...new Map(results.map(item => [item["guid"], item])).values()];
			this._applicationEntitiesCache = {
				entities: results
			};
			return {
				entities: results
			};
		} catch (ex) {
			Logger.error(ex, "NR: getEntities");
		}
		return {
			entities: []
		};
	}

	@lspHandler(GetObservabilityErrorGroupMetadataRequestType)
	@log({
		timed: true
	})
	async getErrorGroupMetadata(
		request: GetObservabilityErrorGroupMetadataRequest
	): Promise<GetObservabilityErrorGroupMetadataResponse | undefined> {
		if (!request.errorGroupGuid) return undefined;

		try {
			const metricResponse = await this.getMetric(request.errorGroupGuid);
			if (!metricResponse) return undefined;

			const mappedEntity = await this.findMappedRemoteByEntity(metricResponse?.entityGuid);
			return {
				entityId: metricResponse?.entityGuid,
				occurrenceId: metricResponse?.traceId!,
				remote: mappedEntity?.url
			} as GetObservabilityErrorGroupMetadataResponse;
		} catch (ex) {
			Logger.error(ex, "NR: getErrorGroupMetadata", {
				request: request
			});
		}
		return undefined;
	}

	@lspHandler(GetObservabilityErrorAssignmentsRequestType)
	@log({
		timed: true
	})
	async getObservabilityErrorAssignments(request: GetObservabilityErrorAssignmentsRequest) {
		const response: GetObservabilityErrorAssignmentsResponse = { items: [] };

		try {
			const { users } = SessionContainer.instance();
			const me = await users.getMe();

			const result = await this.getErrorsInboxAssignments(me.user.email);
			if (result) {
				response.items = result.actor.errorsInbox.errorGroups.results
					.filter(_ => {
						// dont show IGNORED or RESOLVED errors
						return !_.state || _.state === "UNRESOLVED";
					})
					.map((_: any) => {
						return {
							entityId: _.entityGuid,
							errorGroupGuid: _.id,
							errorClass: _.name,
							message: _.message,
							errorGroupUrl: _.url
						} as ObservabilityErrorCore;
					});
			}
		} catch (ex) {
			Logger.warn("NR: getObservabilityErrorAssignments", {
				error: ex
			});
		}

		return response;
	}

	@lspHandler(GetObservabilityReposRequestType)
	@log({
		timed: true
	})
	async getObservabilityRepos(request: GetObservabilityReposRequest) {
		const response: GetObservabilityReposResponse = { repos: [] };
		try {
			const { scm } = SessionContainer.instance();
			const reposResponse = await scm.getRepos({ inEditorOnly: true, includeRemotes: true });
			let filteredRepos: ReposScm[] | undefined = reposResponse?.repositories;
			if (request?.filters?.length) {
				const repoIds = request.filters.map(_ => _.repoId);
				filteredRepos = reposResponse.repositories?.filter(r => r.id && repoIds.includes(r.id))!;
			}

			filteredRepos = filteredRepos?.filter(_ => _.id);
			if (!filteredRepos || !filteredRepos.length) return response;

			for (const repo of filteredRepos) {
				if (!repo.remotes) continue;

				const remotes = repo.remotes.map(_ => {
					return (_ as any).uri!.toString();
				});

				const entities = await this.getEntitiesByRepoRemote(remotes);
				response.repos.push({
					repoId: repo.id!,
					repoName: repo.folder.name,
					repoRemote: remotes[0],
					hasRepoAssociation: entities.filter(_ => _.tags.find(t => t.key === "url")).length > 0,

					// @ts-ignore
					entityAccounts: entities
						.map(entity => {
							const accountIdTag = entity.tags.find(_ => _.key === "accountId");
							if (!accountIdTag) {
								return undefined;
							}
							const accountIdValue = parseInt(accountIdTag.values[0] || "0", 10);
							return {
								accountId: accountIdValue,
								accountName: entity.tags.find(_ => _.key === "account")?.values[0] || "Account",
								entityGuid: entity.guid,
								entityName: entity.name
							} as EntityAccount;
						})
						.filter(Boolean)
				});
			}
		} catch (ex) {
			Logger.error(ex, "NR: getObservabilityRepos");
		}

		return response;
	}

	@lspHandler(GetObservabilityErrorsRequestType)
	@log({
		timed: true
	})
	async getObservabilityErrors(request: GetObservabilityErrorsRequest) {
		const response: GetObservabilityErrorsResponse = { repos: [] };

		try {
			// NOTE: might be able to eliminate some of this if we can get a list of entities
			const { scm } = SessionContainer.instance();
			const reposResponse = await scm.getRepos({ inEditorOnly: true, includeRemotes: true });
			let filteredRepos: ReposScm[] | undefined = reposResponse?.repositories;
			if (request?.filters?.length) {
				const repoIds = request.filters.map(_ => _.repoId);
				filteredRepos = reposResponse.repositories?.filter(r => r.id && repoIds.includes(r.id))!;
			}
			filteredRepos = filteredRepos?.filter(_ => _.id);

			if (!filteredRepos || !filteredRepos.length) return response;

			for (const repo of filteredRepos) {
				if (!repo.remotes) continue;

				const observabilityErrors: ObservabilityError[] = [];
				const remotes = repo.remotes.map(_ => {
					return (_ as any).uri!.toString();
				});

				const entities = await this.getEntitiesByRepoRemote(remotes);
				if (entities?.length) {
					const entityFilter = request.filters?.find(_ => _.repoId === repo.id!);
					for (const entity of entities.filter((_, index) =>
						entityFilter && entityFilter.entityGuid
							? _.guid === entityFilter.entityGuid
							: index == 0
					)) {
						const accountIdTag = entity.tags.find(_ => _.key === "accountId");
						if (!accountIdTag) {
							Logger.warn("NR: count not find accountId for entity", {
								entityGuid: entity.guid
							});
							continue;
						}

						const accountIdValue = parseInt(accountIdTag.values[0] || "0", 10);
						const urlTag = entity.tags.find(_ => _.key === "url");
						const urlValue = urlTag?.values[0];

						const related = await this.findRelatedEntity(entity.guid);
						const applicationGuid = related.actor.entity.relatedEntities.results.find(
							(r: any) => r.type === "BUILT_FROM"
						)?.source.entity.guid;

						if (!applicationGuid) continue;

						const response = await this.getFingerprintedErrorTraces(
							accountIdValue,
							applicationGuid
						);
						if (response.actor.account.nrql.results) {
							const groupedByFingerprint = _groupBy(
								response.actor.account.nrql.results,
								"fingerprint"
							);
							const errorTraces = [];
							for (const k of Object.keys(groupedByFingerprint)) {
								const groupedObject = _sortBy(groupedByFingerprint[k], r => -r.timestamp);
								const lastObject = groupedObject[0];
								errorTraces.push({
									fingerPrintId: k,
									length: groupedObject.length,
									appName: lastObject.appName,
									lastOccurrence: lastObject.timestamp,
									occurrenceId: lastObject.id,
									errorClass: lastObject["error.class"],
									message: lastObject.message,
									entityGuid: lastObject.entityGuid
								});
							}

							for (const errorTrace of errorTraces) {
								try {
									const response = await this.getErrorGroupFromNameMessageEntity(
										errorTrace.errorClass,
										errorTrace.message,
										errorTrace.entityGuid
									);

									if (response && response.actor.errorsInbox.errorGroup) {
										observabilityErrors.push({
											entityId: errorTrace.entityGuid,
											appName: errorTrace.appName,
											errorClass: errorTrace.errorClass,
											message: errorTrace.message,
											remote: urlValue!,
											errorGroupGuid: response.actor.errorsInbox.errorGroup.id,
											occurrenceId: errorTrace.occurrenceId,
											count: errorTrace.length,
											lastOccurrence: errorTrace.lastOccurrence,
											errorGroupUrl: response.actor.errorsInbox.errorGroup.url
										});
										if (observabilityErrors.length > 4) {
											break;
										}
									}
								} catch (ex) {
									Logger.warn("NR: internal error getErrorGroupGuid", {
										ex: ex
									});
								}
							}
						}
					}
				} else {
				}
				response.repos.push({
					repoId: repo.id!,
					repoName: repo.folder.name,
					errors: observabilityErrors!
				});
			}
		} catch (ex) {
			Logger.error(ex, "getObservabilityErrors");
		}
		return response as any;
	}

	@log()
	async getPixieToken(accountId: number) {
		try {
			await this.ensureConnected();
			const response = await this.query(
				`query fetchPixieAccessToken($accountId:Int!) {
  					actor {
    					account(id: $accountId) {
      						pixie {
        						pixieAccessToken
      						}
						}
  					}
				}
			  	`,
				{
					accountId: accountId
				}
			);
			return response.actor.account.pixie.pixieAccessToken;
		} catch (e) {
			Logger.error(e);
			throw e;
		}
	}

	@lspHandler(GetNewRelicAccountsRequestType)
	@log()
	async getAccounts(): Promise<GetNewRelicAccountsResponse> {
		try {
			await this.ensureConnected();
			const response = await this.query<{
				actor: {
					accounts: { id: number; name: string }[];
				};
			}>(`{
				actor {
					accounts {
						id,
						name
					}
				}
			}`);
			return response.actor;
		} catch (e) {
			Logger.error(e, "NR: getAccounts");
			throw e;
		}
	}

	@lspHandler(GetNewRelicErrorGroupRequestType)
	@log()
	async getNewRelicErrorGroupData(
		request: GetNewRelicErrorGroupRequest
	): Promise<GetNewRelicErrorGroupResponse | undefined> {
		let errorGroup: NewRelicErrorGroup | undefined = undefined;
		let accountId = 0;
		let entityId: string = "";
		try {
			await this.ensureConnected();

			if (!request.occurrenceId) {
				throw new Error("MissingOccurrenceId");
			}

			const errorGroupGuid = request.errorGroupGuid;
			const parsedId = this.parseId(errorGroupGuid)!;
			accountId = parsedId.accountId;

			const results = await this.fetchErrorGroupData(accountId, errorGroupGuid);
			if (results) {
				entityId = results["entity.guid"];
				errorGroup = {
					entity: {},
					accountId: accountId,
					entityGuid: entityId,
					guid: results["error.group.guid"],
					title: results["error.group.name"],
					message: results["error.group.message"],
					nrql: results["error.group.nrql"],
					source: results["error.group.source"],
					timestamp: results["timestamp"],
					errorGroupUrl: `${this.productUrl}/redirect/errors-inbox/${errorGroupGuid}`,
					entityUrl: `${this.productUrl}/redirect/entity/${results["entity.guid"]}`,
					state: "UNRESOLVED",
					states: ["RESOLVED", "IGNORED", "UNRESOLVED"]
				};

				errorGroup.attributes = {
					Timestamp: { type: "timestamp", value: errorGroup.timestamp }
					// TODO fix me
					// "Host display name": { type: "string", value: "11.11.11.11:11111" },
					// "URL host": { type: "string", value: "value" },
					// "URL path": { type: "string", value: "value" }
				};

				const errorGroupResponse = await this.getErrorGroup(errorGroupGuid, entityId);
				errorGroup.errorGroupUrl = errorGroupResponse.actor.errorsInbox.errorGroup.url;
				errorGroup.entityName = errorGroupResponse.actor.entity.name;
				errorGroup.entityAlertingSeverity = errorGroupResponse.actor.entity.alertSeverity;
				errorGroup.state = errorGroupResponse.actor.errorsInbox.errorGroup.state || "UNRESOLVED";

				const assignee = errorGroupResponse.actor.errorsInbox.errorGroup.assignment;
				if (assignee) {
					errorGroup.assignee = {
						email: assignee.email,
						id: assignee.userInfo?.id,
						name: assignee.userInfo?.name,
						gravatar: assignee.userInfo?.gravatar
					};
				}

				const builtFromRepo = this.findBuiltFrom(
					errorGroupResponse.actor.entity.relatedEntities.results
				);
				if (builtFromRepo) {
					errorGroup.entity = {
						repo: {
							name: builtFromRepo.name,
							urls: [builtFromRepo.url]
						}
					};
				}

				const stackTraceResult = await this.getStackTrace(entityId, request.occurrenceId);
				if (stackTraceResult?.actor?.entity?.exception?.stackTrace) {
					errorGroup.errorTrace = {
						path: stackTraceResult.actor.entity.name,
						stackTrace: stackTraceResult.actor.entity.crash
							? stackTraceResult.actor.entity.crash.stackTrace.frames
							: stackTraceResult.actor.entity.exception.stackTrace.frames
					};
					errorGroup.hasStackTrace = true;
				}

				Logger.log("NR: ErrorGroup found", {
					errorGroupGuid: errorGroup.guid,
					occurrenceId: request.occurrenceId,
					entityId: entityId,
					hasErrorGroup: errorGroup != null,
					hasStackTrace: errorGroup?.hasStackTrace
				});
			} else {
				Logger.warn(
					`NR: No errorGroup results errorGroupGuid (${errorGroupGuid}) in account (${accountId})`,
					{
						request: request,
						entityId: entityId,
						accountId: accountId
					}
				);
				return {
					accountId: accountId,
					error: {
						message: `Could not find error info for that errorGroupGuid in account (${accountId})`,
						details: (await this.buildErrorDetailSettings(
							accountId,
							entityId,
							errorGroupGuid
						)) as any
					}
				};
			}

			return {
				accountId,
				errorGroup
			};
		} catch (ex) {
			Logger.error(ex);

			let result: any = {};
			if (ex.response?.errors) {
				result = {
					message: ex.response.errors.map((_: { message: string }) => _.message).join("\n")
				};
			} else {
				result = { message: ex.message ? ex.message : ex.toString() };
			}

			result.details = (await this.buildErrorDetailSettings(
				accountId,
				entityId,
				request.errorGroupGuid
			)) as any;

			return {
				error: result,
				accountId,
				errorGroup: undefined as any
			};
		}
	}

	@lspHandler(GetNewRelicAssigneesRequestType)
	@log()
	async getAssignableUsers(request: { boardId: string }) {
		await this.ensureConnected();

		const { scm } = SessionContainer.instance();
		const committers = await scm.getLatestCommittersAllRepos();
		let users: any[] = [];
		if (committers?.scm) {
			users = users.concat(
				Object.keys(committers.scm).map((_: string) => {
					return {
						id: _,
						email: _,
						group: "GIT"
					};
				})
			);
		}

		// TODO fix me get users from NR

		// users.push({
		// 	id: "123",
		// 	displayName: "Some One",
		// 	email: "someone@newrelic.com",
		// 	avatarUrl: "http://...",
		// 	group: "NR"
		// });

		return {
			users: users
		};
	}

	@log()
	async setAssignee(request: {
		errorGroupGuid: string;
		emailAddress: string;
	}): Promise<Directives | undefined> {
		try {
			const response = await this.setAssigneeByEmail(request!);
			const assignment = response.errorsInboxAssignErrorGroup.assignment;
			// won't be a userInfo object if assigning by email

			return {
				directives: [
					{
						type: "setAssignee",
						data: {
							assignee: {
								email: assignment.email,
								id: assignment?.userInfo?.id,
								name: assignment?.userInfo?.name
							}
						}
					}
				]
			};
		} catch (ex) {
			Logger.error(ex);
			return undefined;
		}
	}

	@log()
	async removeAssignee(request: {
		errorGroupGuid: string;
		emailAddress?: string;
		userId?: string;
	}): Promise<Directives | undefined> {
		try {
			await this.setAssigneeByUserId({ ...request, userId: "0" });

			return {
				directives: [
					{
						type: "removeAssignee",
						data: {
							assignee: null
						}
					}
				]
			};
		} catch (ex) {
			Logger.error(ex);
			return undefined;
		}
	}

	@log()
	async setState(request: {
		errorGroupGuid: string;
		state: "RESOLVED" | "UNRESOLVED" | "IGNORED";
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();

			const response = await this.mutate<{
				errorTrackingUpdateErrorGroupState: {
					errors?: { description: string }[];
					state?: string;
				};
			}>(
				`mutation UpdateErrorGroupState($errorGroupGuid: ID!, $state: ErrorsInboxErrorGroupState!) {
					errorsInboxUpdateErrorGroupState(id: $errorGroupGuid, state: $state) {
					  state
					  errors {
						description
						type
					  }
					}
				  }
				  `,
				{
					errorGroupGuid: request.errorGroupGuid,
					state: request.state
				}
			);

			Logger.log("NR: errorsInboxUpdateErrorGroupState", {
				request: request,
				response: response
			});

			if (response?.errorTrackingUpdateErrorGroupState?.errors?.length) {
				const stateFailure = response.errorTrackingUpdateErrorGroupState.errors
					.map(_ => _.description)
					.join("\n");
				Logger.warn("NR: errorsInboxUpdateErrorGroupState failure", {
					error: stateFailure
				});
				throw new Error(stateFailure);
			}

			return {
				directives: [
					{
						type: "setState",
						data: {
							state: request.state
						}
					}
				]
			};
		} catch (ex) {
			Logger.error(ex as Error);
			throw ex;
		}
	}

	@log()
	async assignRepository(request: {
		/** this is a field that can be parsed to get an accountId */
		parseableAccountId: string;
		errorGroupGuid?: string;
		entityId?: string;
		name?: string;
		url: string;
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();

			const parsedId = this.parseId(request.parseableAccountId)!;
			const accountId = parsedId.accountId;
			const name = request.name;

			const response = await this.mutate<{
				referenceEntityCreateOrUpdateRepository: {
					created: string[];
					failures: {
						guid: string;
						message: string;
						type: string;
					}[];
				};
			}>(
				`mutation ReferenceEntityCreateOrUpdateRepository($accountId: Int!, $name: String!, $url: String!) {
					referenceEntityCreateOrUpdateRepository(repositories: [{accountId: $accountId, name: $name, url: $url}]) {
					  created
					  failures {
						guid
						message
						type
					  }
					}
				  }
			  `,
				{
					accountId: accountId,
					name: name,
					url: request.url
				}
			);
			Logger.log("NR: referenceEntityCreateOrUpdateRepository", {
				accountId: accountId,
				name: name,
				url: request.url,
				response: response
			});

			if (response?.referenceEntityCreateOrUpdateRepository?.failures?.length) {
				const failures = response.referenceEntityCreateOrUpdateRepository.failures
					.map(_ => `${_.message} (${_.type})`)
					.join("\n");
				Logger.warn("NR: referenceEntityCreateOrUpdateRepository failures", {
					accountId: accountId,
					name: name,
					url: request.url,
					failures: failures
				});
				throw new Error(failures);
			}

			const repoEntityId = response.referenceEntityCreateOrUpdateRepository.created[0];
			const entityId =
				request.entityId ||
				(await this.getEntityIdFromErrorGroupGuid(accountId, request.errorGroupGuid!));
			if (entityId) {
				const entityRelationshipUserDefinedCreateOrReplaceResponse = await this.mutate<{
					errors?: { message: string }[];
				}>(
					`mutation EntityRelationshipUserDefinedCreateOrReplace($sourceEntityGuid:EntityGuid!, $targetEntityGuid:EntityGuid!) {
						entityRelationshipUserDefinedCreateOrReplace(sourceEntityGuid: $sourceEntityGuid, targetEntityGuid: $targetEntityGuid, type: BUILT_FROM) {
						  errors {
							message
							type
						  }
						}
					  }
				  `,
					{
						sourceEntityGuid: entityId,
						targetEntityGuid: repoEntityId
					}
				);
				Logger.log("NR: entityRelationshipUserDefinedCreateOrReplace", {
					sourceEntityGuid: entityId,
					targetEntityGuid: repoEntityId,
					response: entityRelationshipUserDefinedCreateOrReplaceResponse
				});

				if (entityRelationshipUserDefinedCreateOrReplaceResponse?.errors?.length) {
					const createOrReplaceError = entityRelationshipUserDefinedCreateOrReplaceResponse.errors
						.map(_ => _.message)
						.join("\n");
					Logger.warn("NR: entityRelationshipUserDefinedCreateOrReplace failure", {
						error: createOrReplaceError
					});
					throw new Error(createOrReplaceError);
				}

				return {
					directives: [
						{
							type: "assignRepository",
							data: {
								id: request.errorGroupGuid,
								entityGuid:
									response.referenceEntityCreateOrUpdateRepository &&
									response.referenceEntityCreateOrUpdateRepository.created
										? response.referenceEntityCreateOrUpdateRepository.created[0]
										: undefined,
								repo: {
									accountId: accountId,
									name: request.name,
									urls: [request.url]
								}
							}
						}
					]
				};
			} else {
				Logger.warn("NR: entityId needed for entityRelationshipUserDefinedCreateOrReplace is null");
				throw new Error("Could not locate entityId");
			}
		} catch (ex) {
			Logger.error(ex, "NR: assignRepository", {
				request: request
			});
			throw ex;
		}
	}

	@log()
	private async getUserId(): Promise<number | undefined> {
		try {
			if (this._newRelicUserId != null) {
				return this._newRelicUserId;
			}

			const response = await this.query(`{ actor {	user { id } } }`);
			const id = response.actor?.user?.id;
			if (id) {
				this._newRelicUserId = parseInt(id, 10);
				return this._newRelicUserId;
			}
		} catch (ex) {
			Logger.warn("NR: getUserId " + ex.message);
		}
		return undefined;
	}

	private async getEntityIdFromErrorGroupGuid(
		accountId: number,
		errorGroupGuid: string
	): Promise<string | undefined> {
		try {
			const results = await this.fetchErrorGroupData(accountId, errorGroupGuid);
			return results ? results["entity.guid"] : undefined;
		} catch (ex) {
			Logger.error(ex, "NR: getEntityIdFromErrorGroupGuid", {
				errorGroupGuid: errorGroupGuid,
				accountId: accountId
			});
			return undefined;
		}
	}

	private async fetchErrorGroupData(accountId: number, errorGroupGuid: string) {
		let breakError;
		for (const item of MetricsLookupBackoffs) {
			if (breakError) {
				throw breakError;
			}
			try {
				let response = await this.query(
					`query fetchErrorsInboxData($accountId:Int!) {
					actor {
					  account(id: $accountId) {
						nrql(query: "FROM ${
							item.table
						} SELECT entity.guid, error.group.guid, error.group.message, error.group.name, error.group.source, error.group.nrql WHERE error.group.guid = '${Strings.sanitizeGraphqlValue(
						errorGroupGuid
					)}' SINCE ${item.since} ago LIMIT 1") { nrql results }
					  }
					}
				  }
				  `,
					{
						accountId: accountId
					}
				);
				const results = response.actor.account.nrql.results[0];
				if (results) {
					return results;
				}
			} catch (ex) {
				Logger.warn("NR: lookup failure", {
					accountId,
					errorGroupGuid,
					item
				});
				let accessTokenError = ex as {
					message: string;
					innerError?: { message: string };
					isAccessTokenError: boolean;
				};
				if (
					accessTokenError &&
					accessTokenError.innerError &&
					accessTokenError.isAccessTokenError
				) {
					breakError = new Error(accessTokenError.message);
				}
			}
		}
		return undefined;
	}

	private async getStackTrace(entityId: string, occurrenceId: string) {
		let fingerprintId = 0;
		try {
			// BrowserApplicationEntity uses a fingerprint instead of an occurrence and it's a number
			if (occurrenceId.match(/^-?\d+$/)) {
				fingerprintId = parseInt(occurrenceId, 10);
				occurrenceId = "";
			}
		} catch {}

		let response = undefined;
		try {
			response = await this.query<StackTraceResponse>(
				`query getTrace($entityId: EntityGuid!, $occurrenceId: String!, $fingerprintId:Int!) {
			actor {
			  entity(guid: $entityId) {
				... on ApmApplicationEntity {
				  name
				  exception(occurrenceId: $occurrenceId) {
					message
					stackTrace {
					  frames {
						filepath
						formatted
						line
						name
					  }
					}
				  }
				}
				... on BrowserApplicationEntity {
				  guid
				  name
				  exception(fingerprint: $fingerprintId) {
					message
					stackTrace {
					  frames {
						column
						line
						formatted
						name
					  }
					}
				  }
				}
				... on MobileApplicationEntity {
				  guid
				  name
				  exception(occurrenceId: $occurrenceId) {
					stackTrace {
					  frames {
						line
						formatted
						name
					  }
					}
				  }
				  crash(occurrenceId: $occurrenceId) {
					stackTrace {
					  frames {
						line
						formatted
						name
					  }
					}
				  }
				}
			  }
			}
		  }
		  `,
				{
					entityId: entityId,
					occurrenceId: occurrenceId,
					fingerprintId: fingerprintId
				}
			);
		} catch (ex) {
			Logger.error(ex, "NR: getStackTrace");
		}

		return response;
	}

	private async getErrorGroup(
		errorGroupGuid: string,
		entityGuid: string
	): Promise<ErrorGroupResponse> {
		return this.query(
			`query getErrorGroup($errorGroupGuid: ID!, $entityGuid: EntityGuid!) {
			actor {
			  entity(guid: $entityGuid) {
				alertSeverity
				name
				relatedEntities(filter: {direction: BOTH, relationshipTypes: {include: BUILT_FROM}}) {
				  results {
					source {
					  entity {
						name
						guid
						type
					  }
					}
					target {
					  entity {
						name
						guid
						type
						tags {
							key
							values
						}
					  }
					}
					type
				  }
				}
			  }
			  errorsInbox {
				errorGroup(id: $errorGroupGuid) {
				  url
				  assignment {
					email
					userInfo {
					  gravatar
					  id
					  name
					}
				  }
				  id
				  state
				}
			  }
			}
		  }
		  `,
			{
				errorGroupGuid: errorGroupGuid,
				entityGuid: entityGuid
			}
		);
	}

	private async buildErrorDetailSettings(
		accountId: number,
		entityId: string,
		errorGroupGuid: string
	) {
		let meUser = undefined;
		const { users, session } = SessionContainer.instance();
		try {
			meUser = await users.getMe();
		} catch {}
		if (
			meUser &&
			meUser.user &&
			(meUser.user.email.indexOf("@newrelic.com") > -1 ||
				meUser.user.email.indexOf("@codestream.com") > -1)
		) {
			return {
				settings: {
					accountId: accountId,
					errorGroupGuid: errorGroupGuid,
					entityId: entityId,
					codeStreamUserId: meUser?.user?.id,
					codeStreamTeamId: session?.teamId,
					apiUrl: this.apiUrl
				}
			};
		}
		return undefined;
	}

	private async getRepoRemoteVariants(remotes: string[]): Promise<string> {
		const set = new Set();

		await Promise.all(
			remotes.map(async _ => {
				const variants = await GitRemoteParser.getRepoRemoteVariants(_);
				variants.forEach(v => {
					set.add(`tags.url = '${v.value}'`);
				});
				return true;
			})
		);
		const remoteFilter = Array.from(set).join(" OR ");

		return remoteFilter;
	}

	private async getEntitiesByRepoRemote(
		remotes: string[]
	): Promise<
		{
			guid: string;
			name: String;
			tags: { key: string; values: string[] }[];
		}[]
	> {
		const remoteFilter = await this._memoizedGetRepoRemoteVariants(remotes);
		if (!remoteFilter.length) return [];

		const queryResponse = await this.query<EntitySearchResponse>(`{
			actor {
			  entitySearch(query: "type = 'REPOSITORY' and (${remoteFilter})") {
				count
				query
				results {
				  entities {
					guid
					name
					tags {
					  key
					  values
					}
				  }
				}
			  }
			}
		  }
		  `);
		return queryResponse.actor.entitySearch.results.entities;
	}

	private async getFingerprintedErrorTraces(accountId: number, applicationGuid: string) {
		return this.query(
			`query fetchErrorsInboxData($accountId:Int!) {
				actor {
				  account(id: $accountId) {
					nrql(query: "SELECT id, fingerprint, appName, error.class, message, entityGuid FROM ErrorTrace WHERE fingerprint IS NOT NULL and entityGuid='${applicationGuid}'  SINCE 3 days ago LIMIT 500") { nrql results }
				  }
				}
			  }
			  `,
			{
				accountId: accountId
			}
		);
	}

	private async findRelatedEntity(
		guid: string
	): Promise<{
		actor: {
			entity: {
				relatedEntities: {
					results: RelatedEntity[];
				};
			};
		};
	}> {
		return this.query(
			`query fetchRelatedEntities($guid:EntityGuid!){
			actor {
			  entity(guid: $guid) {
				relatedEntities(filter: {direction: BOTH, relationshipTypes: {include: BUILT_FROM}}) {
				  results {
					source {
					  entity {
						name
						guid
						type
					  }
					}
					target {
					  entity {
						name
						guid
						type
						tags {
							key
							values
						}
					  }
					}
					type
				  }
				}
			  }
			}
		  }
		  `,
			{
				guid: guid
			}
		);
	}

	private async getErrorGroupFromNameMessageEntity(
		name: string,
		message: string,
		entityGuid: string
	) {
		return this.query(
			`query getErrorGroupGuid($name: String!, $message:String!, $entityGuid:EntityGuid!){
			actor {
			  errorsInbox {
				errorGroup(errorEvent: {name: $name, 
				  message: $message, 
				  entityGuid: $entityGuid}) {
				  id
				  url											 
				}
			  }
			}
		  }									  
	  `,
			{
				name: name,
				message: message,
				entityGuid: entityGuid
			}
		);
	}

	private async getErrorsInboxAssignments(
		emailAddress: string,
		userId?: number
	): Promise<ErrorGroupsResponse | undefined> {
		try {
			if (userId == null || userId == 0) {
				// TODO fix me. remove this once we have a userId on a connection
				userId = await this.getUserId();
			}
			return this.query(
				`query getAssignments($userId: Int, $emailAddress: String!) {
				actor {
				  errorsInbox {
					errorGroups(filter: {isAssigned: true, assignment: {userId: $userId, userEmail: $emailAddress}}) {
					  results {
						url
						state
						name
						message
						id
						entityGuid
					  }
					}
				  }
				}
			  }
			  
  `,
				{
					userId: userId,
					emailAddress: emailAddress
				}
			);
		} catch (ex) {
			Logger.warn("NR: getErrorsInboxAssignments", {
				userId: userId,
				emailAddress: emailAddress != null
			});
			return undefined;
		}
	}
	/**
	 * from an errorGroupGuid, returns a traceId and an entityId
	 *
	 * @private
	 * @param {string} errorGroupGuid
	 * @return {*}  {(Promise<
	 * 		| {
	 * 				entityGuid: string;
	 * 				traceId: string;
	 * 		  }
	 * 		| undefined
	 * 	>)}
	 * @memberof NewRelicProvider
	 */
	private async getMetric(
		errorGroupGuid: string
	): Promise<
		| {
				entityGuid: string;
				traceId: string;
		  }
		| undefined
	> {
		try {
			let accountId = this.parseId(errorGroupGuid)?.accountId!;
			const response = await this.query<{
				actor: {
					account: {
						errorGroups: {
							results: {
								["error.group.name"]: string;
								["error.group.message"]: string;
							}[];
						};
					};
				};
			}>(
				`query getMetric($accountId: Int!) {
					actor {
					  account(id: $accountId) {
						errorGroups: nrql(query: "FROM Metric SELECT error.group.name,error.group.message WHERE error.group.guid = '${Strings.sanitizeGraphqlValue(
							errorGroupGuid
						)}' SINCE 7 day ago LIMIT 1") {
						  results
						}
					  }
					}
				  }				  
			`,
				{
					accountId: accountId
				}
			);
			if (response) {
				const metricResult = response.actor.account.errorGroups.results[0];
				const response2 = await this.query<{
					actor: {
						account: {
							errorEvents: {
								results: {
									entityGuid: string;
									id: string;
								}[];
							};
						};
					};
				}>(
					`query getMetric($accountId: Int!) {
						actor {
						  account(id: $accountId) {
							errorEvents: nrql(query: "FROM ErrorTrace SELECT * WHERE error.class LIKE '${Strings.sanitizeGraphqlValue(
								metricResult["error.group.name"]
							)}' AND error.message LIKE '${Strings.sanitizeGraphqlValue(
						metricResult["error.group.message"]
					)}' SINCE 1 week ago LIMIT 1") {
							  results
							}
						  }
						}
					  }					  
			`,
					{
						accountId: accountId
					}
				);

				if (response2) {
					const errorTraceResult = response2.actor.account.errorEvents.results[0];
					if (errorTraceResult) {
						return {
							entityGuid: errorTraceResult.entityGuid,
							traceId: errorTraceResult.id
						};
					}
				}
			}
		} catch (ex) {
			Logger.error(ex, "NR: getMetric", {
				errorGroupGuid: errorGroupGuid
			});
		}
		return undefined;
	}

	private async findMappedRemoteByEntity(
		entityGuid: string
	): Promise<
		| {
				url: string;
				name: string;
		  }
		| undefined
	> {
		if (!entityGuid) return undefined;

		const relatedEntityResponse = await this.findRelatedEntity(entityGuid);
		if (relatedEntityResponse) {
			return this.findBuiltFrom(relatedEntityResponse.actor.entity.relatedEntities.results);
		}
		return undefined;
	}

	private setAssigneeByEmail(request: { errorGroupGuid: string; emailAddress: string }) {
		return this.query(
			`mutation errorsInboxAssignErrorGroup($email: String!, $errorGroupGuid: ID!) {
			errorsInboxAssignErrorGroup(assignment: {userEmail: $email}, id: $errorGroupGuid) {
			  assignment {
				email
				userInfo {
				  email
				  gravatar
				  id
				  name
				}
			  }
			}
		  }
		  `,
			{
				email: request.emailAddress,
				errorGroupGuid: request.errorGroupGuid
			}
		);
	}

	private setAssigneeByUserId(request: { errorGroupGuid: string; userId: string }) {
		return this.query(
			`mutation errorsInboxAssignErrorGroup($userId: Int!, $errorGroupGuid: ID!) {
				errorsInboxAssignErrorGroup(assignment: {userId: $userId}, id: $errorGroupGuid) {
				  assignment {
					email
					userInfo {
					  email
					  gravatar
					  id
					  name
					}
				  }
				}
			  }`,
			{
				errorGroupGuid: request.errorGroupGuid,
				userId: parseInt(request.userId, 10)
			}
		);
	}

	private findBuiltFrom(
		relatedEntities: RelatedEntity[]
	):
		| {
				url: string;
				name: string;
		  }
		| undefined {
		if (!relatedEntities || !relatedEntities.length) return undefined;

		const buildFrom = relatedEntities.find(_ => _.type === "BUILT_FROM");
		if (buildFrom) {
			const targetUrl = buildFrom.target.entity.tags.find((_: any) => _.key === "url");
			if (targetUrl && targetUrl.values && targetUrl.values.length) {
				return {
					url: targetUrl.values[0],
					name: buildFrom.target.entity.name
				};
			}
		}

		return undefined;
	}

	private parseId(idLike: string): NewRelicId | undefined {
		try {
			const parsed = Buffer.from(idLike, "base64").toString("utf-8");
			if (!parsed) return undefined;

			const split = parsed.split(/\|/);
			//"140272|ERT|ERR_GROUP|12076a73-fc88-3205-92d3-b785d12e08b6"
			const [accountId, unknownAbbreviation, entityType, unknownGuid] = split;
			return {
				accountId: accountId != null ? parseInt(accountId, 10) : 0,
				unknownAbbreviation,
				entityType,
				unknownGuid
			};
		} catch (e) {
			Logger.warn("NR: " + e.message, {
				idLike
			});
		}
		return undefined;
	}
}
