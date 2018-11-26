import EventEmitter, { IpcHost, IpcResponse } from "./event-emitter";
import { shortUuid } from "./utils";

let sequence = 0;

export default class WebviewApi {
	pendingRequests = new Map();
	host: IpcHost;

	constructor() {
		this.host = EventEmitter.getHost();
		EventEmitter.on("response", ({ id, payload, error }: IpcResponse) => {
			const request = this.pendingRequests.get(id);
			if (request) {
				console.debug("codestream:response", { id, payload, error });
				if (payload !== undefined) request.resolve(payload);
				else {
					request.reject(
						error ||
							`No payload and no error provided by host process in response to ${request.action}`
					);
				}
				this.pendingRequests.delete(id);
			}
		});
	}

	postMessage(message: { [key: string]: any }) {
		if (sequence === Number.MAX_SAFE_INTEGER) {
			sequence = 1;
		} else {
			sequence++;
		}

		const id = `${sequence}:${shortUuid()}`;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject, action: message.action });
			console.debug("codestream:request", { id, ...message });
			this.host.postMessage({ type: "codestream:request", body: { id, ...message } }, "*");
		});
	}

	bootstrap() {
		return this.postMessage({ action: "bootstrap" });
	}

	startSignup() {
		return this.postMessage({ action: "go-to-signup" });
	}

	startSlackSignin() {
		return this.postMessage({ action: "go-to-slack-signin" });
	}

	validateSignup(token: string) {
		return this.postMessage({ action: "validate-signup", params: token });
	}

	authenticate(params: object) {
		return this.postMessage({ action: "authenticate", params });
	}

	fetchPosts(params: object) {
		return this.postMessage({ action: "fetch-posts", params });
	}

	fetchThread(streamId: string, parentPostId: string) {
		return this.postMessage({ action: "fetch-thread", params: { streamId, parentPostId } });
	}

	createPost(post: object) {
		console.log("Creating a post with: ", post);
		return this.postMessage({ action: "create-post", params: post });
	}

	editPost(params: object) {
		return this.postMessage({ action: "edit-post", params });
	}

	reactToPost(params: object) {
		return this.postMessage({ action: "react-to-post", params });
	}

	setPostStatus(params: object) {
		return this.postMessage({ action: "set-post-status", params });
	}

	deletePost(params: object) {
		return this.postMessage({ action: "delete-post", params });
	}

	createStream(stream: object) {
		return this.postMessage({ action: "create-stream", params: stream });
	}

	renameStream(streamId: string, name: string) {
		return this.postMessage({ action: "rename-stream", params: { streamId, name } });
	}

	setStreamPurpose(streamId: string, purpose: string) {
		return this.postMessage({ action: "set-stream-purpose", params: { streamId, purpose } });
	}

	joinStream(params: object) {
		return this.postMessage({ action: "join-stream", params });
	}

	leaveStream(teamId: string, streamId: string) {
		return this.postMessage({ action: "leave-stream", params: { teamId, streamId } });
	}

	archiveStream(streamId: string, archive: boolean) {
		return this.postMessage({ action: "archive-stream", params: { streamId, archive } });
	}

	removeUsersFromStream(streamId: string, userIds: string[]) {
		return this.postMessage({ action: "remove-users-from-stream", params: { streamId, userIds } });
	}

	addUsersToStream(streamId: string, userIds: string[]) {
		return this.postMessage({ action: "add-users-to-stream", params: { streamId, userIds } });
	}

	invite(attributes: object) {
		return this.postMessage({ action: "invite", params: attributes });
	}

	markStreamRead(streamId: string, postId?: string) {
		return this.postMessage({ action: "mark-stream-read", params: { streamId, postId } });
	}

	markPostUnread(streamId: string, postId: string) {
		return this.postMessage({
			action: "mark-post-unread",
			params: { streamId: streamId, id: postId }
		});
	}

	showMarkersInEditor(value: Boolean) {
		return this.postMessage({
			action: "show-markers",
			params: value
		});
	}

	muteAllConversations(value: Boolean) {
		return this.postMessage({
			action: "mute-all",
			params: value
		});
	}

	openCommentOnSelectInEditor(value: Boolean) {
		return this.postMessage({
			action: "open-comment-on-select",
			params: value
		});
	}

	saveUserPreference(newPreference: object) {
		return this.postMessage({ action: "save-user-preference", params: newPreference });
	}

	showCode(marker: object, enteringThread: boolean) {
		return this.postMessage({ action: "show-code", params: { marker, enteringThread } });
	}

	closeDirectMessage(streamId: string) {
		return this.postMessage({ action: "close-direct-message", params: streamId });
	}

	openDirectMessage(streamId: string) {
		return this.postMessage({ action: "open-stream", params: streamId });
	}

	changeStreamMuteState(streamId: string, muted: boolean) {
		return this.postMessage({ action: "change-stream-mute-state", params: { streamId, muted } });
	}

	editCodemark(params: {
		id: string;
		text: string;
		title: string;
		color: string;
		assignees: string[];
	}) {
		return this.postMessage({ action: "edit-codemark", params });
	}

	fetchCodemarks(teamId: string) {
		return this.postMessage({ action: "fetch-codemarks", params: teamId });
	}

	setCodemarkStatus(params: { id: string; status: string }) {
		return this.postMessage({ action: "set-codemark-status", params });
	}
}
