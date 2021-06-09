import { ActionType, Index } from "../common";
import * as actions from "./actions";
import { ProviderPullRequestActionsTypes, ProviderPullRequestsState } from "./types";
import { createSelector } from "reselect";
import { CodeStreamState } from "..";
import { CSRepository } from "@codestream/protocols/api";

type ProviderPullRequestActions = ActionType<typeof actions>;

const initialState: ProviderPullRequestsState = { pullRequests: {}, myPullRequests: {} };

const createNewObject = (state, action) => {
	const newState = { ...state.pullRequests };
	newState[action.payload.providerId] = newState[action.payload.providerId] || {};
	return newState;
};

export function reduceProviderPullRequests(
	state = initialState,
	action: ProviderPullRequestActions
): ProviderPullRequestsState {
	switch (action.type) {
		case ProviderPullRequestActionsTypes.AddMyPullRequests: {
			const newState = { ...state.myPullRequests };
			newState[action.payload.providerId] = {
				data: action.payload.data
			};
			return {
				myPullRequests: newState,
				pullRequests: { ...state.pullRequests }
			};
		}
		case ProviderPullRequestActionsTypes.RemoveFromMyPullRequests: {
			const newState = { ...state.myPullRequests };
			// newState[action.payload.providerId] = {
			// 	data: (newState[action.payload.providerId].data || []).filter(
			// 		_ => _.id !== action.payload.id
			// 	)
			// };
			return {
				myPullRequests: newState,
				pullRequests: { ...state.pullRequests }
			};
		}
		case ProviderPullRequestActionsTypes.ClearMyPullRequests: {
			const newState = { ...state.myPullRequests };
			newState[action.payload.providerId] = {
				data: undefined
			};
			return {
				myPullRequests: newState,
				pullRequests: { ...state.pullRequests }
			};
		}
		case ProviderPullRequestActionsTypes.AddPullRequestFiles: {
			const newState = createNewObject(state, action);
			newState[action.payload.providerId][action.payload.id] = {
				...newState[action.payload.providerId][action.payload.id],
				files: action.payload.pullRequestFiles
			};
			return {
				myPullRequests: { ...state.myPullRequests },
				pullRequests: newState
			};
		}
		case ProviderPullRequestActionsTypes.ClearPullRequestFiles: {
			const newState = createNewObject(state, action);
			newState[action.payload.providerId][action.payload.id] = {
				...newState[action.payload.providerId][action.payload.id],
				files: []
			};
			return {
				myPullRequests: { ...state.myPullRequests },
				pullRequests: newState
			};
		}
		case ProviderPullRequestActionsTypes.AddPullRequestCommits: {
			const newState = createNewObject(state, action);
			newState[action.payload.providerId][action.payload.id] = {
				...newState[action.payload.providerId][action.payload.id],
				commits: action.payload.pullRequestCommits
			};
			return {
				myPullRequests: { ...state.myPullRequests },
				pullRequests: newState
			};
		}
		case ProviderPullRequestActionsTypes.ClearPullRequestCommits: {
			const newState = createNewObject(state, action);
			newState[action.payload.providerId][action.payload.id] = {
				...newState[action.payload.providerId][action.payload.id],
				commits: []
			};
			return {
				myPullRequests: { ...state.myPullRequests },
				pullRequests: newState
			};
		}
		case ProviderPullRequestActionsTypes.AddPullRequestConversations: {
			const newState = createNewObject(state, action);
			newState[action.payload.providerId][action.payload.id] = {
				...newState[action.payload.providerId][action.payload.id],
				conversations: action.payload.pullRequest
			};
			return {
				myPullRequests: { ...state.myPullRequests },
				pullRequests: newState
			};
		}
		case "RESET":
			return initialState;
		default:
			return state;
	}
}
const getRepos = (state: CodeStreamState) => Object.values(state.repos);
const getProviderPullRequests = (state: CodeStreamState) => state.providerPullRequests;
const currentPullRequest = (state: CodeStreamState) => state.context.currentPullRequest;
const currentPullRequestId = (state: CodeStreamState) =>
	state.context.currentPullRequest ? state.context.currentPullRequest.id : undefined;

/**
 * Gets the PR object for the currentPullRequestId
 */
export const getCurrentProviderPullRequest = createSelector(
	getProviderPullRequests,
	currentPullRequestId,
	(providerPullRequests, id) => {
		if (!id) return undefined;
		for (const providerPullRequest of Object.values(providerPullRequests)) {
			for (const pullRequests of Object.values(providerPullRequest)) {
				if (!pullRequests) continue;
				const data = pullRequests[id];
				if (data) return data;
			}
		}
		return undefined;
	}
);

/**
 *  Attempts to get a CS repo for the current PR
 */
export const getProviderPullRequestRepo = createSelector(
	getRepos,
	getCurrentProviderPullRequest,
	(repos, currentPr) => {
		try {
			if (!currentPr || !currentPr.conversations) return undefined;
			const repoName = currentPr.conversations.repository.repoName.toLowerCase();
			const repoUrl = currentPr.conversations.repository.url.toLowerCase();
			let currentRepo: CSRepository | undefined = undefined;
			let matchingRepos = repos.filter(_ => _.name && _.name.toLowerCase() === repoName);
			if (matchingRepos.length != 1) {
				matchingRepos = matchingRepos.filter(_ =>
					_.remotes.some(r => repoUrl.indexOf(r.normalizedUrl.toLowerCase()) > -1)
				);
				if (matchingRepos.length === 1) {
					currentRepo = matchingRepos[0];
				} else {
					console.warn(`Could not find repo for repoName=${repoName} repoUrl=${repoUrl}`);
				}
			} else {
				currentRepo = matchingRepos[0];
			}
			return currentRepo;
		} catch (error) {}
		return undefined;
	}
);
