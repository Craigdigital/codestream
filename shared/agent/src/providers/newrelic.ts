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
	ThirdPartyDisconnect
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
import { UsersManager } from "managers/usersManager";

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

	get myUrl() {
		const usingEU =
			this._providerInfo && this._providerInfo.data && this._providerInfo.data.usingEU;
		if (usingEU) {
			return "https://api.eu.newrelic.com";
		}
		return this.session.api.baseUrl.toLowerCase().indexOf("https://api.codestream.com") > -1
			? "https://api.newrelic.com"
			: "https://staging-api.newrelic.com";
	}

	get productUrl() {
		const usingEU =
			this._providerInfo && this._providerInfo.data && this._providerInfo.data.usingEU;
		if (usingEU) {
			return "https://one.eu.newrelic.com";
		}
		return this.session.api.baseUrl.toLowerCase().indexOf("https://api.codestream.com") > -1
			? "https://one.newrelic.com"
			: "https://staging-one.newrelic.com";
	}

	get baseUrl() {
		return this.myUrl;
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
			"Content-Type": "application/json"
		});

		return this._client;
	}

	@log()
	async configure(request: NewRelicConfigurationData) {
		await this.session.api.setThirdPartyProviderToken({
			providerId: this.providerConfig.id,
			token: request.apiKey,
			data: {
				accountId: request.accountId
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
			Logger.warn(`New Relic query caught:`, ex);
			const exType = this._isSuppressedException(ex);
			if (exType !== undefined) {
				this.trySetThirdPartyProviderInfo(ex, exType);

				// this throws the error but won't log to sentry (for ordinary network errors that seem temporary)
				throw new InternalError(exType, { error: ex });
			} else {
				// this is an unexpected error, throw the exception normally
				throw ex;
			}
		}

		return response;
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
				Logger.warn("Invalid NRQL results:", results);
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
			//"140272|ERT|ERR_GROUP|12026a73-fc72-3205-92d3-b785d12e08b6"
			const [accountId, unknownAbbreviation, entityType, unknownGuid] = split;
			return {
				accountId: accountId != null ? parseInt(accountId, 10) : 0,
				unknownAbbreviation,
				entityType,
				unknownGuid
			};
		} catch (e) {
			Logger.warn(e.message, {
				idLike
			});
		}
		return undefined;
	}

	private async getEntityIdFromErrorGroupGuid(
		errorGroupGuid: string,
		accountId: number
	): Promise<string | undefined> {
		try {
			const response = await this.query(
				`query fetchErrorsInboxData($accountId:Int!) {
				actor {
				  account(id: $accountId) {
					nrql(query: "FROM Metric SELECT entity.guid WHERE error.group.guid = '${Strings.santizeGraphqlValue(
						errorGroupGuid
					)}' SINCE 7 day ago LIMIT 1") { nrql results }
				  }
				}
			  }
			  `,
				{
					accountId: accountId
				}
			);

			const results = response.actor?.account?.nrql?.results[0] || {};
			return results ? results["entity.guid"] : undefined;
		} catch (ex) {
			Logger.error(ex, "getEntityIdFromErrorGroupGuid", {
				errorGroupGuid: errorGroupGuid,
				accountId: accountId
			});
			return undefined;
		}
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
		try {
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
					guid: entityId
				}
			);
			if (!relatedEntitiesResponse?.actor.entity) return undefined;

			const remote = relatedEntitiesResponse?.actor?.entity?.relatedEntities?.results.find(
				(_: {
					type: string;
					target: {
						entity: NewRelicEntity;
					};
				}) => _.type === "BUILT_FROM"
			);
			if (!remote) return undefined;

			if (remote.target?.entity?.type === "REPOSITORY") {
				const urlTag = remote.target.entity.tags.find(
					(_: { key: string; values: string[] }) => _.key === "url"
				);
				if (urlTag) {
					return {
						name: remote.target.entity.name,
						urls: urlTag.values
					};
				}
			}
		} catch (ex) {
			Logger.error(ex, "getEntityRepoRelationship", {
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
			Logger.warn(ex.message, {
				errorGroupGuid: errorGroupGuid
			});
			return undefined;
		}
	}

	@log()
	async getPixieToken() {
		const accountId = this._providerInfo?.data?.accountId || 1;
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

	@lspHandler(GetNewRelicErrorGroupRequestType)
	@log()
	async getNewRelicErrorGroupData(
		request: GetNewRelicErrorGroupRequest
	): Promise<GetNewRelicErrorGroupResponse | undefined> {
		let errorGroup: NewRelicErrorGroup | undefined = undefined;

		let meUser = undefined;
		const { users, session } = SessionContainer.instance();
		try {
			meUser = await users.getMe();
		} catch {}

		let accountId = 0;
		let entityId: string = "";
		try {
			await this.ensureConnected();

			const errorGroupGuid = request.errorGroupGuid;
			const parsedId = this.parseId(errorGroupGuid)!;
			accountId = parsedId.accountId;

			let response;
			response = await this.query(
				`query fetchErrorsInboxData($accountId:Int!) {
					actor {
					  account(id: $accountId) {
						nrql(query: "FROM Metric SELECT entity.guid, error.group.guid, error.group.message, error.group.name, error.group.source, error.group.nrql WHERE error.group.guid = '${Strings.santizeGraphqlValue(
							errorGroupGuid
						)}' SINCE 7 day ago LIMIT 1") { nrql results }
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
					// TODO fix me
					state: "UNRESOLVED",
					states: ["RESOLVED", "IGNORED", "UNRESOLVED"]
				};

				const repo = await this.getEntityRepoRelationship(entityId);
				if (repo) {
					errorGroup.entity = { repo: repo };
				}

				if (entityId) {
					response = await this.query(
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

				if (!request.traceId) {
					// HACK to find a traceId if none supplied -- find the latest traceId
					const queryAsString = `
					query fetchErrorsInboxData($accountId:Int!) {
						actor {
						  account(id: $accountId) {
							nrql(query: "FROM ErrorTrace SELECT * WHERE entityGuid = '${entityId}' and message = '${results[
						"error.group.message"
					].replace(/'/g, "\\'")}' LIMIT 1") { 
						results 
					}
						  }
						}
					  }
					  `;
					const tracesResponse = await this.query(queryAsString, {
						accountId: accountId
					});
					if (tracesResponse?.actor?.account?.nrql?.results?.length) {
						request.traceId = tracesResponse?.actor.account.nrql.results[0].traceId;
					}
				}

				const errorGroupState = await this.getErrorGroupState(errorGroupGuid);
				if (errorGroupState) {
					errorGroup.state = errorGroupState.actor.errorsInbox.errorGroup.state;
					const assignee = errorGroupState.actor.errorsInbox.errorGroup.assignedUser;
					if (assignee) {
						errorGroup.assignee = assignee;
					}
				}

				const stackTraceResult = await this.query(
					`query getTrace($entityId: EntityGuid!, $traceId: String!) {
				actor {
				  entity(guid: $entityId) {
					... on ApmApplicationEntity {
					  name
					  stackTrace(occurrenceId: $traceId) {
						message
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
			  `,
					{
						entityId: entityId,
						traceId: request.traceId
					}
				);

				if (stackTraceResult?.actor?.entity) {
					errorGroup.errorTrace = {
						path: stackTraceResult.actor.entity.name,
						stackTrace: stackTraceResult.actor.entity.stackTrace.frames
					};
					errorGroup.hasStackTrace = true;
				}

				Logger.debug("NR:ErrorGroup", {
					errorGroup: errorGroup
				});
			} else {
				Logger.warn(
					`No errorGroup results errorGroupGuid (${errorGroupGuid}) in account (${accountId})`,
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
					error?: any;
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
			Logger.error(ex);
			return undefined;
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
					created: string;
				};
			}>(
				`mutation assignRepository($accountId: Int!, $name: String!, $url: String!) {
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
			if (!response.referenceEntityCreateOrUpdateRepository.created?.length) {
				Logger.warn("referenceEntityCreateOrUpdateRepository created length is 0 ", {
					accountId: accountId,
					name: name,
					url: request.url
				});
			}
			const repoId = response.referenceEntityCreateOrUpdateRepository.created[0];

			const entityId =
				request.entityId || (await this.getEntityIdFromErrorGroupGuid(errorGroupGuid, accountId));
			if (entityId) {
				const related = await this.mutate(
					`mutation createRelation($sourceEntityGuid:EntityGuid!, $targetEntityGuid:EntityGuid!) {
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
						targetEntityGuid: repoId
					}
				);
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
		} catch (ex) {
			Logger.error(ex, "assignRepository", {
				request: request
			});
			return undefined;
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
					codeStreamTeamId: session?.teamId
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
