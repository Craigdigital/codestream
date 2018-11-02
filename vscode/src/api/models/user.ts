"use strict";
import { CSMe, CSUser } from "../../agent/agentConnection";
import { CodeStreamSession } from "../session";
import { CodeStreamItem } from "./item";

export class User extends CodeStreamItem<CSUser> {
	constructor(session: CodeStreamSession, user: CSUser) {
		super(session, user);
	}

	get email() {
		return this.entity.email;
	}

	get fullName() {
		return `${this.entity.firstName || ""} ${this.entity.lastName || ""}`.trim();
	}

	get name() {
		return this.entity.username || this.fullName;
	}

	hasMutedChannel(streamId: string) {
		const preferences = (this.entity as CSMe).preferences;
		if (preferences === undefined) return false;

		const mutedStreams = preferences.mutedStreams;
		if (mutedStreams === undefined) return false;

		return mutedStreams[streamId] === true;
	}
}
