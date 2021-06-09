import { ActionType } from "../common";
import * as actions from "./actions";
import { PreferencesActionsType, PreferencesState, FilterQuery } from "./types";
import { merge, mergeWith } from "lodash-es";
import { createSelector } from "reselect";
import { CodeStreamState } from "..";
import { PullRequestQuery } from "@codestream/protocols/api";

type PreferencesActions = ActionType<typeof actions>;

const initialState: PreferencesState = {};

const mergeCustom = function(target, source) {
	// don't merge arrays, just copy ... at least i hope that's the right solution
	if (source instanceof Array) {
		return [...source];
	}
};
export function reducePreferences(state = initialState, action: PreferencesActions) {
	switch (action.type) {
		case PreferencesActionsType.Set:
		case PreferencesActionsType.Update: {
			return mergeWith({}, state, action.payload, mergeCustom);
		}
		case "RESET":
			return initialState;
		default:
			return state;
	}
}

export const getSavedSearchFilters = createSelector(
	(state: CodeStreamState) => state.preferences,
	preferences => {
		const savedSearchFilters: FilterQuery[] = [];
		Object.keys(preferences.savedSearchFilters || {}).forEach(key => {
			savedSearchFilters[parseInt(key, 10)] = preferences.savedSearchFilters[key];
		});
		return savedSearchFilters.filter(filter => filter.label.length > 0);
	}
);

// FIXME hard-coded github*com
const DEFAULT_QUERIES: { [index: number]: PullRequestQuery } = {
	// { name: "Local PR Branches", query: `is:pr author:@me`, hidden: false, repoOnly: true },
	0: {
		providerId: "github*com",
		name: "Waiting on my Review",
		query: `is:pr is:open review-requested:@me`,
		hidden: false
	},
	1: {
		providerId: "github*com",
		name: "Assigned to Me",
		query: `is:pr is:open assignee:@me`,
		hidden: false
	},
	2: {
		providerId: "github*com",
		name: "Created by Me",
		query: `is:pr is:open author:@me`,
		hidden: false
	}
};

export const getSavedPullRequestQueries = createSelector(
	(state: CodeStreamState) => state.preferences,
	(_, providerId: string) => providerId,
	(preferences, providerId) => {
		const pullRequestQueries: PullRequestQuery[] = [];
		const queries = preferences.pullRequestQueries || DEFAULT_QUERIES;
		Object.keys(queries).forEach(key => {
			pullRequestQueries[parseInt(key, 10)] = queries[key];
		});
		return pullRequestQueries.filter(q => q && q.providerId === providerId && q.query.length > 0);
	}
);
