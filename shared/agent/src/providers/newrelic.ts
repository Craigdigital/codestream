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
	GetNewRelicAssigneesRequestType
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

export interface Directive {
	type: "removeAssignee" | "setAssignee" | "setState";
	data: any;
}

interface Directives {
	directives: Directive[];
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
		} else {
			// TODO need a switch or something for this
			return Logger.isDebugging ? "https://staging-api.newrelic.com" : "https://api.newrelic.com";
		}
	}

	get productUrl() {
		return Logger.isDebugging ? "https://staging-one.newrelic.com" : "https://one.newrelic.com";
	}

	get baseUrl() {
		return this.myUrl;
	}

	get graphQlBaseUrl() {
		return `${this.baseUrl}/graphql`;
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

	async query<T = any>(query: string, variables: any = undefined) {
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

	@lspHandler(GetNewRelicErrorGroupRequestType)
	@log()
	async getNewRelicErrorsInboxData(
		request: GetNewRelicErrorGroupRequest
	): Promise<GetNewRelicErrorGroupResponse | undefined> {
		// TODO fix me need real values
		let repo = "git@github.com:teamcodestream/codestream-server-demo";
		let sha = "9542e9c702f0879f8407928eb313b33174a7c2b5";
		let errorGroup: NewRelicErrorGroup | undefined = undefined;
		let accountId;
		try {
			await this.ensureConnected();

			accountId = this._providerInfo?.data?.accountId;
			if (!accountId) {
				throw new Error("must provide an accountId");
			}

			let response;
			const errorGroupId = request.errorGroupId;

			response = await this.query(
				`query fetchErrorsInboxData($accountId:Int!) {
					actor {
					  account(id: $accountId) {
						nrql(query: "FROM Metric SELECT entity.guid, error.group.guid, error.group.message, error.group.name, error.group.source, error.group.nrql WHERE error.group.guid = '${errorGroupId}' SINCE 24 hours ago LIMIT 1") { nrql results }
					  }
					}
				  }
				  `,
				{
					accountId: parseInt(accountId, 10)
				}
			);
			const results = response.actor.account.nrql.results[0];
			let entityId;
			if (results) {
				entityId = results["entity.guid"];
				errorGroup = {
					entityGuid: entityId,
					guid: results["error.group.guid"],
					title: results["error.group.name"],
					message: results["error.group.message"],
					nrql: results["error.group.nrql"],
					source: results["error.group.source"],
					timestamp: results["timestamp"],
					errorGroupUrl: `${this.productUrl}/redirect/errors-inbox/${errorGroupId}`,
					entityUrl: `${this.productUrl}/redirect/entity/${results["entity.guid"]}`,
					// TODO fix me
					state: "UNRESOLVED",
					states: ["RESOLVED", "IGNORED", "UNRESOLVED"]
				};
				response = await this.query(
					`{
						actor {
						  entity(guid: "${errorGroup?.entityGuid}") {
							alertSeverity
							name
						  }
						}
					  }
				  `
				);
				errorGroup.entityName = response.actor.entity.name;
				errorGroup.entityAlertingSeverity = response.actor.entity.alertSeverity;

				// if (request.traceId) {
				// 	const tracesResponse = await this.query(
				// 		`query fetchErrorsInboxData($accountId:Int!) {
				// 			actor {
				// 			  account(id: $accountId) {
				// 				nrql(query: "FROM ErrorTrace SELECT * WHERE entityGuid = '${entityId}' and message=${results[
				// 			"error.group.message"
				// 		].replace(/'/g, "\\'")} LIMIT 1") { results }
				// 			  }
				// 			}
				// 		  }
				// 		  `,
				// 		{
				// 			accountId: parseInt(accountId, 10)
				// 		}
				// 	);
				// 	if (tracesResponse?.actor.account.results) {
				// 	}
				// 	// /FROM ErrorTrace SELECT * WHERE entityGuid = 'MzQwMjYyfEFQTXxBUFBMSUNBVElPTnw0MjIxMDk4' LIMIT  1
				// }

				// TODO fix me
				errorGroup.errorTrace = {
					id: "10d5c489-049f-11ec-86ae-0242ac110009_14970_28033",
					path: "WebTransaction/SpringController/api/urlRules/{accountId}/{applicationId} (GET)",
					stackTrace: [
						{
							formatted:
								"\torg.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1013)"
						},
						{
							formatted:
								"\torg.springframework.web.servlet.FrameworkServlet.doGet(FrameworkServlet.java:897)"
						},
						{
							formatted: "\tjavax.servlet.http.HttpServlet.service(HttpServlet.java:634)"
						},
						{
							formatted:
								"\torg.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:882)"
						},
						{
							formatted: "\tjavax.servlet.http.HttpServlet.service(HttpServlet.java:741)"
						},
						{
							formatted:
								"\torg.apache.catalina.core.ApplicationFilterChain.internalDoFilter(ApplicationFilterChain.java:231)"
						},
						{
							formatted:
								"\torg.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:166)"
						},
						{
							formatted: "\torg.apache.tomcat.websocket.server.WsFilter.doFilter(WsFilter.java:53)"
						},
						{
							formatted:
								"\torg.apache.catalina.core.ApplicationFilterChain.internalDoFilter(ApplicationFilterChain.java:193)"
						},
						{
							formatted:
								"\torg.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:166)"
						},
						{
							formatted:
								"\torg.springframework.boot.actuate.web.trace.servlet.HttpTraceFilter.doFilterInternal(HttpTraceFilter.java:88)"
						},
						{
							formatted:
								"\torg.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:109)"
						}
					]
				};

				// TODO fix me below does not work yet
				const foo = false;
				if (foo) {
					const assigneeResults = await this.query(`{
						actor {
						  entity(guid: "${entityId}") {
							... on WorkloadEntity {
							  guid
							  name
							  errorGroup(id: "${errorGroupId}") {
								assignedUser {
								  email
								  gravatar
								  id
								  name
								}
								state
								id
							  }
							}
						  }
						}
					  }
					  `);
					if (assigneeResults) {
						errorGroup.state = assigneeResults.actor.entity.errorGroup.state;
						const assignee = assigneeResults.actor.entity.errorGroup.assignedUser;
						if (assignee) {
							errorGroup.assignee = assignee;
						}
					}

					const stackTraceResult = await this.query(`{
					actor {
					  entity(guid: "<entityId>") {
						... on ApmApplicationEntity {
						  guid
						  name
						  errorTrace(traceId: "<traceId>") {
							id
							exceptionClass
							intrinsicAttributes
							message
							path
							stackTrace {
							  filepath
							  line
							  name
							  formatted
							}
						  }
						}
					  }
					}
				  }
				  `);
				}
				Logger.debug("NR:ErrorGroup", {
					errorGroup: errorGroup
				});
				errorGroup.repo = repo;
				// TODO fix me
				errorGroup.hasStackTrace = true;
			} else {
				Logger.log("No results", {
					request: request
				});
			}

			return {
				repo,
				sha,
				accountId,
				errorGroup
			};
		} catch (ex) {
			Logger.error(ex);
			return {
				repo: repo,
				sha: sha,
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
		errorGroupId: string;
		userId: number;
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();
			// TODO fix me
			// const response = await this.query(
			// 	`mutation {
			// 		errorTrackingAssignErrorGroup(id: "${request.errorGroupId}", assignment: {userId: ${request.userId}}) {
			// 		  errors {
			// 			description
			// 			type
			// 		  }
			// 		  assignedUser {
			// 			email
			// 			gravatar
			// 			id
			// 			name
			// 		  }
			// 		}
			// 	  }`
			// );
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
	async removeAssignee(request: { errorGroupId: string }): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();
			// TODO fix me
			// const response = await this.query(
			// 	`mutation {
			// 		errorTrackingAssignErrorGroup(id: "${request.errorGroupId}", assignment: {userId: ${request.userId}}) {
			// 		  errors {
			// 			description
			// 			type
			// 		  }
			// 		  assignedUser {
			// 			email
			// 			gravatar
			// 			id
			// 			name
			// 		  }
			// 		}
			// 	  }`
			// );
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
		errorGroupId: string;
		state: string;
	}): Promise<Directives | undefined> {
		try {
			await this.ensureConnected();

			// "RESOLVED" | "UNRESOLVED" | "IGNORED"
			// const response = await this.mutate<{
			// 	errorTrackingUpdateErrorGroupState: {
			// 		error?: any;
			// 		state?: string;
			// 	};
			// }>(
			// 	`mutation setState($errorGroupId:ID!, $state:ErrorTrackingErrorGroupState) {
			// 		errorTrackingUpdateErrorGroupState(id:
			// 		  $errorGroupId, state: {state: $state}) {
			// 		  state
			// 		  errors {
			// 			description
			// 			type
			// 		  }
			// 		}
			// 	  }`,
			// 	{
			// 		errorGroupId: request.errorGroupId,
			// 		state: request.state
			// 	}
			// );
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
}
