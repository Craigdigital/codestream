import { CSCodeError, CSStackTraceInfo, CSStackTraceLine } from "@codestream/protocols/api";
import { action } from "../common";
import { CodeErrorsActionsTypes } from "./types";
import { HostApi } from "@codestream/webview/webview-api";
import {
	UpdateCodeErrorRequestType,
	DeleteCodeErrorRequestType,
	CreateShareableCodeErrorRequestType,
	GetCodeErrorRequestType,
	FetchCodeErrorsRequestType,
	ResolveStackTraceRequestType,
	ResolveStackTracePositionRequestType,
	UpdateCodeErrorResponse,
	GetNewRelicErrorGroupRequestType,
	GetNewRelicErrorGroupRequest,
	ExecuteThirdPartyTypedType,
	GetNewRelicErrorGroupResponse
} from "@codestream/protocols/agent";
import { logError } from "@codestream/webview/logger";
import { addStreams } from "../streams/actions";
import { CodeStreamState } from "..";
import { mapFilter } from "@codestream/webview/utils";
import { addPosts } from "../posts/actions";
import { createPost } from "@codestream/webview/Stream/actions";
import { getTeamMembers } from "../users/reducer";
import { phraseList } from "@codestream/webview/utilities/strings";
import { Position, Range } from "vscode-languageserver-types";
import { highlightRange } from "../../Stream/api-functions";

export const reset = () => action("RESET");

export const _bootstrapCodeErrors = (codeErrors: CSCodeError[]) =>
	action(CodeErrorsActionsTypes.Bootstrap, codeErrors);

export const bootstrapCodeErrors = () => async dispatch => {
	const { codeErrors } = await HostApi.instance.send(FetchCodeErrorsRequestType, {});
	dispatch(_bootstrapCodeErrors(codeErrors));
};

export const addCodeErrors = (codeErrors: CSCodeError[]) =>
	action(CodeErrorsActionsTypes.AddCodeErrors, codeErrors);

export const saveCodeErrors = (codeErrors: CSCodeError[]) =>
	action(CodeErrorsActionsTypes.SaveCodeErrors, codeErrors);

export const updateCodeErrors = (codeErrors: CSCodeError[]) =>
	action(CodeErrorsActionsTypes.UpdateCodeErrors, codeErrors);

export interface NewCodeErrorAttributes {
	accountId: number;
	objectId?: string;
	objectType?: "ErrorGroup";
	objectInfo?: any;
	title: string;
	text?: string;
	stackTraces: CSStackTraceInfo[];
	assignees?: string[];
	addedUsers?: string[];
	entryPoint?: string;
	replyPost?: {
		text: string;
		mentionedUserIds?: string[];
	};
	providerUrl?: string;
}

export interface CreateCodeErrorError {
	reason: "share" | "create";
	message?: string;
}

export const createCodeError = (attributes: NewCodeErrorAttributes) => async (
	dispatch,
	getState: () => CodeStreamState
) => {
	try {
		const response = await HostApi.instance.send(CreateShareableCodeErrorRequestType, {
			attributes,
			entryPoint: attributes.entryPoint,
			addedUsers: attributes.addedUsers,
			replyPost: attributes.replyPost
		});
		if (response) {
			dispatch(addCodeErrors([response.codeError]));
			dispatch(addStreams([response.stream]));
			dispatch(addPosts([response.post]));
		}
		return response;
	} catch (error) {
		logError("Error creating a code error", { message: error.toString() });
		throw { reason: "create", message: error.toString() } as CreateCodeErrorError;
	}
};

export const _deleteCodeError = (id: string) => action(CodeErrorsActionsTypes.Delete, id);

export const deleteCodeError = (id: string) => async dispatch => {
	try {
		await HostApi.instance.send(DeleteCodeErrorRequestType, {
			id
		});
		dispatch(_deleteCodeError(id));
	} catch (error) {
		logError(`failed to delete code error: ${error}`, { id });
	}
};

/**
 * "Advanced" properties that can come from the client (webview)
 */
interface AdvancedEditableCodeErrorAttributes {
	// array of userIds / tags to add
	$push: { assignees?: string[]; tags?: string[] };
	// array of userIds / tags to remove
	$pull: { assignees?: string[]; tags?: string[] };
}

export type EditableAttributes = Partial<
	Pick<CSCodeError, "title" | "assignees"> & AdvancedEditableCodeErrorAttributes
>;

export const editCodeError = (
	id: string,
	attributes: EditableAttributes,
	replyText?: string
) => async (dispatch, getState: () => CodeStreamState) => {
	let response: UpdateCodeErrorResponse | undefined;
	try {
		response = await HostApi.instance.send(UpdateCodeErrorRequestType, {
			id,
			...attributes
		});
		dispatch(updateCodeErrors([response.codeError]));

		if (
			attributes.$push != null &&
			attributes.$push.assignees != null &&
			attributes.$push.assignees.length
		) {
			// if we have additional ids we're adding via $push, map them here
			const filteredUsers = mapFilter(getTeamMembers(getState()), teamMember => {
				const user = attributes.$push!.assignees!.find(_ => _ === teamMember.id);
				return user ? teamMember : undefined;
			}).filter(Boolean);

			if (filteredUsers.length) {
				dispatch(
					createPost(
						response.codeError.streamId,
						response.codeError.postId,
						`/me added ${phraseList(filteredUsers.map(u => `@${u.username}`))} to this code error`,
						null,
						filteredUsers.map(u => u.id)
					)
				);
			}
		}
	} catch (error) {
		logError(`failed to update code error: ${error}`, { id });
	}
	return response;
};

export const fetchCodeError = (codeErrorId: string) => async dispatch => {
	const response = await HostApi.instance.send(GetCodeErrorRequestType, { codeErrorId });

	if (response.codeError) return dispatch(saveCodeErrors([response.codeError]));
};

/**
 *  "resolving" the stack trace here gives us two pieces of info for each line of the stack
 *	the info parsed directly from the stack, and the "resolved" info that is specific to the
 *	file the user has currently in their repo ... this position may be different if the user is
 *	on a particular commit ... the "parsed" stack info is considered permanent, the "resolved"
 *	stack info is considered ephemeral, since it only applies to the current user in the current state
 *	resolved line number that gives the full path and line of the
 * @param repoId
 * @param sha
 * @param traceId
 * @param stackTrace
 * @returns ResolveStackTraceResponse
 */
export const resolveStackTrace = (
	repoId: string,
	sha: string,
	traceId: string,
	stackTrace: string[]
) => {
	return HostApi.instance.send(ResolveStackTraceRequestType, {
		stackTrace,
		repoId,
		sha,
		traceId
	});
};

export const jumpToStackLine = (
	stackLine: CSStackTraceLine,
	sha: string,
	repoId: string
) => async dispatch => {
	const currentPosition = await HostApi.instance.send(ResolveStackTracePositionRequestType, {
		sha,
		repoId,
		filePath: stackLine.fileRelativePath!,
		line: stackLine.line!,
		column: stackLine.column!
	});
	if (currentPosition.error) {
		logError(`Unable to jump to stack trace line: ${currentPosition.error}`);
		return;
	}

	const { line, column, path } = currentPosition;

	const range = Range.create(
		Position.create(line! - 1, column != null ? column : 0),
		Position.create(line! - 1, column != null ? column : 2147483647)
	);
	highlightRange({
		uri: `file://${path!}`,
		range,
		highlight: true
	});
};

export const updateCodeError = request => async dispatch => {
	return HostApi.instance.send(UpdateCodeErrorRequestType, request);
};

export const fetchNewRelicErrorGroup = (
	request: GetNewRelicErrorGroupRequest
) => async dispatch => {
	return HostApi.instance.send(GetNewRelicErrorGroupRequestType, request);
};

export const handleDirectives = (id: string, data: any) =>
	action(CodeErrorsActionsTypes.HandleDirectives, {
		id,
		data
	});

export const _addProviderError = (
	providerId: string,
	errorGroupGuid: string,
	error?: { message: string }
) =>
	action(CodeErrorsActionsTypes.AddProviderError, {
		providerId: providerId,
		id: errorGroupGuid,
		error
	});

export const _clearProviderError = (providerId: string, errorGroupGuid: string) =>
	action(CodeErrorsActionsTypes.ClearProviderError, {
		providerId: providerId,
		id: errorGroupGuid,
		undefined
	});

export const _setErrorGroup = (errorGroupGuid: string, data: any) =>
	action(CodeErrorsActionsTypes.SetErrorGroup, {
		providerId: "newrelic*com",
		id: errorGroupGuid,
		data
	});

export const _isLoadingErrorGroup = (errorGroupGuid: string, data: any) =>
	action(CodeErrorsActionsTypes.IsLoadingErrorGroup, {
		providerId: "newrelic*com",
		id: errorGroupGuid,
		data
	});

export const setProviderError = (
	providerId: string,
	errorGroupGuid: string,
	error?: { message: string }
) => async (dispatch, getState: () => CodeStreamState) => {
	try {
		dispatch(_addProviderError(providerId, errorGroupGuid, error));
	} catch (error) {
		logError(`failed to setProviderError: ${error}`, { providerId, errorGroupGuid });
	}
};

export const clearProviderError = (
	providerId: string,
	id: string,
	error?: { message: string }
) => async (dispatch, getState: () => CodeStreamState) => {
	try {
		dispatch(_clearProviderError(providerId, id));
	} catch (error) {
		logError(`failed to setProviderError: ${error}`, { providerId, id });
	}
};

export const fetchErrorGroup = (codeError: CSCodeError, traceId?: string) => async (
	dispatch,
	getState: () => CodeStreamState
) => {
	let objectId;
	try {
		// this is an errorGroupGuid
		objectId = codeError?.objectId;
		dispatch(_isLoadingErrorGroup(objectId, { isLoading: true }));
		return dispatch(
			fetchNewRelicErrorGroup({
				errorGroupGuid: objectId!,
				traceId: traceId || codeError.stackTraces[0].traceId!
			})
		).then((result: GetNewRelicErrorGroupResponse) => {
			dispatch(_isLoadingErrorGroup(objectId, { isLoading: true }));
			return dispatch(_setErrorGroup(codeError.objectId!, result.errorGroup));
		});
	} catch (error) {
		logError(`failed to fetchErrorGroup: ${error}`, { objectId });
	}
};

/**
 * Try to find a codeError by its objectId
 *
 * @param objectId
 * @param traceId
 * @returns
 */
export const findErrorGroupByObjectId = (objectId: string, traceId?: string) => async (
	dispatch,
	getState: () => CodeStreamState
) => {
	try {
		const locator = (state: CodeStreamState, oid: string, tid?: string) => {
			const codeError = Object.values(state.codeErrors.codeErrors).find(
				(_: CSCodeError) =>
					_.objectId === oid && (tid ? _.stackTraces.find(st => st.traceId === tid) : true)
			);
			return codeError;
		};
		const state = getState();
		if (!state.codeErrors.bootstrapped) {
			return dispatch(bootstrapCodeErrors()).then((_: any) => {
				return locator(getState(), objectId, traceId);
			});
		} else {
			return locator(state, objectId, traceId);
		}
	} catch (error) {
		logError(`failed to findErrorGroupByObjectId: ${error}`, { objectId, traceId });
	}
	return undefined;
};

export const setErrorGroup = (errorGroupGuid: string, data?: any) => async (
	dispatch,
	getState: () => CodeStreamState
) => {
	try {
		dispatch(_setErrorGroup(errorGroupGuid, data));
	} catch (error) {
		logError(`failed to _setErrorGroup: ${error}`, { errorGroupGuid });
	}
};

/**
 * Provider api
 *
 * @param method the method in the agent
 * @param params the data to send to the provider
 * @param options optional options
 */
export const api = <T = any, R = any>(
	method: "assignRepository" | "removeAssignee" | "setAssignee" | "setState",

	params: { errorGroupGuid: string } | any,
	options?: {
		updateOnSuccess?: boolean;
		preventClearError: boolean;
		preventErrorReporting?: boolean;
	}
) => async (dispatch, getState: () => CodeStreamState) => {
	let providerId = "newrelic*com";
	let pullRequestId;
	try {
		// const state = getState();
		// const currentPullRequest = state.context.currentPullRequest;
		// if (!currentPullRequest) {
		// 	dispatch(
		// 		setProviderError(providerId, pullRequestId, {
		// 			message: "currentPullRequest not found"
		// 		})
		// 	);
		// 	return;
		// }
		// ({ providerId, id: pullRequestId } = currentPullRequest);
		// params = params || {};
		// if (!params.pullRequestId) params.pullRequestId = pullRequestId;
		// if (currentPullRequest.metadata) {
		// 	params = { ...params, ...currentPullRequest.metadata };
		// 	params.metadata = currentPullRequest.metadata;
		// }

		const response = (await HostApi.instance.send(new ExecuteThirdPartyTypedType<T, R>(), {
			method: method,
			providerId: "newrelic*com",
			params: params
		})) as any;
		// if (response && (!options || (options && !options.preventClearError))) {
		// 	dispatch(clearProviderError(params.errorGroupGuid, pullRequestId));
		// }

		if (response && response.directives) {
			dispatch(handleDirectives(params.errorGroupGuid, response.directives));
			return {
				handled: true
			};
		}
		return response as R;
	} catch (error) {
		let errorString = typeof error === "string" ? error : error.message;
		if (errorString) {
			if (
				options &&
				options.preventErrorReporting &&
				(errorString.indexOf("ENOTFOUND") > -1 ||
					errorString.indexOf("ETIMEDOUT") > -1 ||
					errorString.indexOf("EAI_AGAIN") > -1 ||
					errorString.indexOf("ECONNRESET") > -1 ||
					errorString.indexOf("ENETDOWN") > -1 ||
					errorString.indexOf("socket disconnected before secure") > -1)
			) {
				// ignores calls where the user might be offline
				console.error(error);
				return undefined;
			}

			const target = "failed with message: ";
			const targetLength = target.length;
			const index = errorString.indexOf(target);
			if (index > -1) {
				errorString = errorString.substring(index + targetLength);
				const jsonIndex = errorString.indexOf(`: {\"`);
				// not the first character
				if (jsonIndex > 0) {
					errorString = errorString.substring(0, jsonIndex);
				}
			}
		}
		// dispatch(
		// 	setProviderError(providerId, params.errorGroupGuid, {
		// 		message: errorString
		// 	})
		// );
		logError(error, { providerId, pullRequestId, method, message: errorString });

		HostApi.instance.track("ErrorGroup Error", {
			Host: providerId,
			Operation: method,
			Error: errorString,
			IsOAuthError: errorString && errorString.indexOf("OAuth App access restrictions") > -1
		});
		return undefined;
	}
};
