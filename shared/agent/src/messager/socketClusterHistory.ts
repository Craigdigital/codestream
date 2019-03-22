// Retrieves recent history of messages from SocketCluster, in case of disconnect or gaps in the session

"use strict";

import { SCClientSocket } from "socketcluster-client";
import UUID from "uuid";
import { MessagerHistoryOutput, MessagerMessage } from "./messager";

export interface SocketClusterHistoryInput {
	scClient: SCClientSocket;
	channels: string[];
	since: number;
	debug?(msg: string, info?: any): void; // for debug messages
}

export interface SocketClusterHistoryAPIInput {
	requestId: string;
	channels: string[];
	since: number;
}

export interface SocketClusterHistoryOutput {
	messages: MessagerMessage[];
	channels: string[];
}

export interface SocketClusterHistoryAPIOutput {
	requestId: string;
	messages: MessagerMessage[];
	channels: string[];
	error?: string;
}

export class SocketClusterHistory {
	private _scClient: SCClientSocket | undefined;
	private _allMessages: MessagerMessage[] = [];
	private _debug: (msg: string, info?: any) => void = () => {};
	private _historyPromise: {
		resolve(): void,
		reject(error: any): void
	} | undefined;
	private _numRequests: number = 0;
	private _requestId: string = "";
	private _historyTimer: NodeJS.Timer | undefined;

	async fetchHistory(options: SocketClusterHistoryInput): Promise<MessagerHistoryOutput> {
		this._scClient = options.scClient;
		if (options.debug) {
			this._debug = options.debug;
		}

		this._scClient.on("history", this.handleHistory.bind(this));

		const output: MessagerHistoryOutput = {};

		// split into slices of 500 channels, which we may never reach, but it's here if we do
		let startSlice = 0;
		let done = false;
		let channels = [];
		const sliceSize = 100; // batch history is limited to 100 channels
		do {
			channels = options.channels.slice(startSlice, sliceSize);
			if (channels.length > 0) {
				if (await this.fetchByChannelSlice(channels, options.since)) {
					startSlice += sliceSize;
				}
				else {
					output.reset = true;
					done = true;
				}
			}
		} while (!done && channels.length > 0);

		if (!output.reset) {
			this._allMessages.sort((a, b) => {
				return a.timestamp - b.timestamp;
			});
			if (this._allMessages.length > 0) {
				// store the last message received, so we know where to start from next time
				output.messages = this._allMessages.map(message => message.message);
				output.timestamp = this._allMessages[this._allMessages.length - 1].timestamp;
			}
		}
		return output;
	}

	// fetch historical messages for a slice of 500 channels
	private async fetchByChannelSlice(channels: string[], since: number): Promise<boolean> {
		try {
			await this.retrieveBatchHistory(channels, since);
		} catch (error) {
			// if we reached a "RESET" condition, break out and inform the client, we'll proceed no further
			if (error === "RESET") {
				return false;
			} else {
				throw error;
			}
		}
		return true;
	}

	// retrieve historical messages in batch
	private retrieveBatchHistory(channels: string[], since: number): Promise<void> | undefined {
		this._requestId = UUID();
		const historyMessage = {
			requestId: this._requestId,
			channels,
			since
		} as SocketClusterHistoryAPIInput;
		this._scClient!.emit("getHistory", historyMessage);
		if (this._numRequests === 0) {
			return new Promise((resolve, reject) => {
				this._historyPromise = { resolve, reject };
				this._historyTimer = setTimeout(() => {
console.warn('REJECTING HISTORY DUE TO TIMEOUT');
					reject("SocketCluster history request timed out");
				}, 5000);
			});
		} else {
			return undefined;
		}
	}

	private handleHistory (output: SocketClusterHistoryAPIOutput) {
console.warn('GOT HISTORY', output);
		if (output.requestId !== this._requestId || !this._historyPromise) {
			return;
		}
		if (this._historyTimer) {
console.warn('clearing timeout...');
			clearTimeout(this._historyTimer);
		}
		if (output.error) {
console.warn('GOT AN ERROR!', output.error);
			this._historyPromise!.reject(output.error);
			return;
		}
		this._allMessages.push(...output.messages);
		if (output.messages.length >= 100) {
			this._numRequests++;
			if (this._numRequests === 10) {
console.warn('REJECTING BY WAY OF RESET');
				this._historyPromise!.reject("RESET");
			}
			const since = output.messages[output.messages.length - 1].timestamp;
			this.retrieveBatchHistory(output.channels, since);
		}
		else {
			this._historyPromise!.resolve();
		}
	}
}
