"use strict";
import { MessageType } from "../api/apiProvider";
import {
	NewRelicErrorGroup,
	GetNewRelicDataRequest,
	GetNewRelicDataRequestType,
	GetNewRelicDataResponse,
	GetNewRelicErrorGroupRequest,
	GetNewRelicErrorGroupRequestType,
	GetNewRelicErrorGroupResponse,
	NewRelicConfigurationData,
	ThirdPartyProviderConfig,
	GetNewRelicAssigneesRequestType,
	NewRelicUser,
	ThirdPartyDisconnect,
	GetNewRelicAccountsRequestType,
	GetNewRelicAccountsResponse
} from "../protocol/agent.protocol";
import { CSMe, CSNewRelicProviderInfo } from "../protocol/api.protocol";
import { log, lspProvider } from "../system";
import { ThirdPartyIssueProviderBase } from "./provider";
import { GraphQLClient } from "graphql-request";
import { InternalError, ReportSuppressedMessages } from "../agentError";
import { Logger } from "../logger";
import { lspHandler } from "../system";
import { CodeStreamSession } from "../session";
import { SessionContainer } from "../container";
import { Strings } from "../system/string";

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
		since: "1 day"
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
	constructor(session: CodeStreamSession, config: ThirdPartyProviderConfig) {
		super(session, config);
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
		super.onDisconnected(request);
	}

	protected async client(): Promise<GraphQLClient> {
		if (this._client === undefined) {
			const options: { [key: string]: any } = {};
			if (this._httpsAgent) {
				options.agent = this._httpsAgent;
			}
			this._client = new GraphQLClient(this.graphQlBaseUrl, options);
		}
		if (!this.accessToken) {
			throw new Error("Could not get a New Relic API key");
		}

		// set accessToken on a per-usage basis... possible for accessToken
		// to be revoked from the source (github.com) and a stale accessToken
		// could be cached in the _client instance.
		this._client.setHeaders({
			"Api-Key": this.accessToken!,
			"Content-Type": "application/json",
			"NewRelic-Requesting-Services": "CodeStream"
		});

		return this._client;
	}

	@log()
	async configure(request: NewRelicConfigurationData) {
		await this.session.api.setThirdPartyProviderToken({
			providerId: this.providerConfig.id,
			token: request.apiKey,
			data: {
				accountId: request.accountId,
				apiUrl: request.apiUrl
			}
		});

		// FIXME - this rather sucks as a way to ensure we have the access token
		return new Promise<void>(resolve => {
			this.session.api.onDidReceiveMessage(e => {
				if (e.type !== MessageType.Users) return;

				const me = e.data.find((u: any) => u.id === this.session.userId) as CSMe | null | undefined;
				if (me == null) return;

				const providerInfo = this.getProviderInfo(me);
				if (providerInfo == null || !providerInfo.accessToken) return;

				resolve();
			});
		});
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
			return requestError.response.errors.find(_ => _.extensions.error_code === "BAD_API_KEY");
		}
		return undefined;
	}

	@lspHandler(GetNewRelicDataRequestType)
	@log()
	async getNewRelicData(request: GetNewRelicDataRequest): Promise<GetNewRelicDataResponse> {
		try {
			await this.ensureConnected();
			const accountId = this._providerInfo?.data?.accountId;
			if (!accountId) {
				throw new Error("must provide an accountId");
			}
			// !!! NEED ESCAPING HERE !!!!
			const query = `
{
	actor {
		account(id:${accountId}) {
			nrql(query: "${request.query}") {
				results
			}
		}
	}
}
`;
			//{"query":"{  actor {    account(id: ${accountId}) {    nrql(query: \"${request.query}\") {        results     }    }  }}", "variables":""}`;
			const response = await this.query(query);
			const results = response?.actor?.account?.nrql?.results;
			if (results) {
				return { data: results as GetNewRelicDataResponse };
			} else {
				Logger.warn("NR: Invalid NRQL results:", results);
				throw new Error("Invalid NRQL results");
			}
		} catch (ex) {
			return { data: {} };
		}
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

	private async getEntityRepoRelationship(
		entityId: string
	): Promise<
		| {
				name: string;
				urls: string[];
		  }
		| undefined
	> {
		let repositoryEntityId;

		try {
			const relatedEntitesResponse0 = await this.query<any>(
				`
	query getRelatedEntities($guid:EntityGuid!) {
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
					guid: entityId
				}
			);

			const repositoryEntity = relatedEntitesResponse0?.actor?.entity?.relatedEntities?.results.find(
				(_: any) => _.source.entity.guid === entityId
			);
			if (repositoryEntity) {
				repositoryEntityId = repositoryEntity.target?.entity?.guid;

				if (repositoryEntityId) {
					const relatedEntitiesResponse = await this.query<{
						actor: {
							entity?: {
								relatedEntities: {
									results: {
										target: {
											entity: NewRelicEntity;
										};
										type: string;
									}[];
								};
							};
						};
					}>(
						`query getRelatedEntities($guid:EntityGuid!) {
			actor {
			  entity(guid:$guid) {
				relatedEntities(filter: {direction: BOTH, relationshipTypes: {include: BUILT_FROM}}) {
				  results {
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
				name
				type
				tags {
				  values
				  key
				}
			  }
			}
		  }`,
						{
							guid: repositoryEntityId
						}
					);
					if (!relatedEntitiesResponse?.actor.entity) {
						Logger.warn(`NR: relatedEntitiesResponse?.actor.entity=null`);
						return undefined;
					}
					const remote = relatedEntitiesResponse?.actor?.entity?.relatedEntities?.results.find(
						(_: {
							type: string;
							target: {
								entity: NewRelicEntity;
							};
						}) => _.type === "BUILT_FROM"
					);
					if (!remote) {
						Logger.warn(`NR: BUILT_FROM remote=null`);
						return undefined;
					}
					if (remote.target?.entity?.type === "REPOSITORY") {
						const urlTag = remote.target.entity.tags.find(
							(_: { key: string; values: string[] }) => _.key === "url"
						);
						if (urlTag) {
							const result = {
								name: remote.target.entity.name,
								urls: urlTag.values
							};
							Logger.log(`NR: found urlTag`, {
								result: result
							});

							return result;
						} else {
							Logger.warn(`NR: key=url is null`);
						}
					} else {
						Logger.warn(`NR: type=REPOSITORY is null`);
					}
				} else {
					Logger.warn(`NR: repositoryEntityId=null`);
				}
			} else {
				Logger.warn(`NR: repositoryEntity=null`);
			}
		} catch (ex) {
			Logger.error(ex, "NR: getEntityRepoRelationship", {
				repositoryEntityId: repositoryEntityId,
				entityId: entityId
			});
		}

		return undefined;
	}

	private async getErrorGroupState(
		errorGroupGuid: string
	): Promise<
		| {
				actor: {
					errorsInbox: {
						errorGroup: {
							assignedUser?: NewRelicUser;
							state?: "RESOLVED" | "IGNORED" | "UNRESOLVED" | string;
						};
					};
				};
		  }
		| undefined
	> {
		try {
			return this.query(
				`query getErrorGroup($errorGroupGuid: ID!) {
			actor {
			  errorsInbox {
				errorGroup(id: $errorGroupGuid) {
				  assignedUser {
					email
					gravatar
					id
					name
				  }
				  id
				  state
				}
			  }
			}
		  }
		   `,
				{
					errorGroupGuid: errorGroupGuid
				}
			);
		} catch (ex) {
			Logger.warn("NR: " + ex.message, {
				errorGroupGuid: errorGroupGuid
			});
			return undefined;
		}
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
			Logger.error(e);
			throw e;
		}
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
						} SELECT entity.guid, error.group.guid, error.group.message, error.group.name, error.group.source, error.group.nrql WHERE error.group.guid = '${Strings.santizeGraphqlValue(
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

				const repo = await this.getEntityRepoRelationship(entityId);
				if (repo) {
					errorGroup.entity = { repo: repo };
				}

				if (entityId) {
					let response = await this.query(
						`{
						actor {
						  entity(guid: "${entityId}") {
							alertSeverity
							name
						  }
						}
					  }
				  `
					);
					errorGroup.entityName = response.actor.entity.name;
					errorGroup.entityAlertingSeverity = response.actor.entity.alertSeverity;
				}
				errorGroup.attributes = {
					Timestamp: { type: "timestamp", value: errorGroup.timestamp }
					// TODO fix me
					// "Host display name": { type: "string", value: "11.11.11.11:11111" },
					// "URL host": { type: "string", value: "value" },
					// "URL path": { type: "string", value: "value" }
				};

				if (!request.occurrenceId) {
					throw new Error("MissingOccurrenceId");
				}

				const errorGroupState = await this.getErrorGroupState(errorGroupGuid);
				if (errorGroupState) {
					errorGroup.state = errorGroupState.actor.errorsInbox.errorGroup.state || "UNRESOLVED";
					const assignee = errorGroupState.actor.errorsInbox.errorGroup.assignedUser;
					if (assignee) {
						errorGroup.assignee = assignee;
					}
				} else {
					Logger.warn("NR: missing errorGroup state");
				}

				const stackTraceResult = await this.query<{
					actor: {
						entity: {
							name: string;
							exception: {
								message?: string;
								stackTrace: {
									frames: { filepath?: string; line?: number; name?: string; formatted: string }[];
								};
							};
						};
					};
				}>(
					`query getTrace($entityId: EntityGuid!, $occurrenceId: String!) {
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
				  }
				}
			  }
			  `,
					{
						entityId: entityId,
						occurrenceId: request.occurrenceId
					}
				);

				if (stackTraceResult?.actor?.entity?.exception?.stackTrace) {
					errorGroup.errorTrace = {
						path: stackTraceResult.actor.entity.name,
						stackTrace: stackTraceResult.actor.entity.exception.stackTrace.frames
					};
					errorGroup.hasStackTrace = true;
				}

				Logger.debug("NR: ErrorGroup found", {
					errorGroupGuid: errorGroup.guid
				});
			} else {
				Logger.warn(
					`NR: No errorGroup results errorGroupGuid (${errorGroupGuid}) in account (${accountId})`,
					{
						request: request,
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
						displayName: _,
						email: _,
						group: "GIT"
					};
				})
			);
		}

		// TODO fix me get users from NR

		// users.push({
		// 	id: "a",
		// 	displayName: "A",
		// 	email: "a@a.com",
		// 	avatarUrl: "A",
		// 	group: "NR"
		// });

		return {
			users: users
		};
	}

	@log()
	async setAssignee(request: {
		errorGroupGuid: string;
		userId: string;
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();
			// TODO fix me
			const response = await this._setAssignee(request);

			// TODO fix me
			return {
				directives: [
					{
						type: "setAssignee",
						data: {
							assignee: {
								email: "cheese@cheese.com",
								id: 1,
								name: "cheese"
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
		userId: string;
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();
			// TODO fix me
			const response = await this._setAssignee({ ...request, userId: "0" });

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
		accountId?: string;
		errorGroupGuid: string;
		entityId?: string;
		name?: string;
		url: string;
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();

			const errorGroupGuid = request.errorGroupGuid;
			const parsedId = this.parseId(errorGroupGuid)!;
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
				request.entityId || (await this.getEntityIdFromErrorGroupGuid(accountId, errorGroupGuid));
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

	private _setAssignee(request: { errorGroupGuid: string; userId: string }) {
		return this.query(
			`mutation removeUser($errorGroupGuid: String!, userId: Int!) {
					errorTrackingAssignErrorGroup(id: $errorGroupGuid, assignment: {userId: $userId}) {
					  errors {
						description
						type
					  }
					  assignedUser {
						email
						gravatar
						id
						name
					  }
					}
				  }`,
			{
				errorGroupGuid: request.errorGroupGuid,
				userId: parseInt(request.userId, 10)
			}
		);
	}
}
