"use strict";

import { PubnubStatus, StatusChangeEvent } from "../../pubnub/pubnubConnection";
import { PubnubTester } from "./pubnubTester";

export class ConfirmFailureTest extends PubnubTester {

	private _didSubscribe: boolean = false;
	private _didConnect: boolean = false;
	private _didGetNetworkProblem: boolean = false;

	describe () {
		return "when subscription confirmation fails after a network event, a Trouble event should be emitted";
	}

	run (): Promise<void> {
		this._pubnubConnection!.onDidStatusChange((event: StatusChangeEvent) => {
			if (
				event.status === PubnubStatus.Connected &&
				this._didSubscribe
			) {
				this._didConnect = true;
				this._pubnubConnection!.simulateNetError(1000);
				this._pubnubConnection!.simulateConfirmFailure();
			}
			else if (
				event.status === PubnubStatus.NetworkProblem &&
				this._didConnect
			) {
				this._didGetNetworkProblem = true;
			}
			else if (
				event.status === PubnubStatus.Trouble &&
				this._didGetNetworkProblem
			) {
				this._resolve();
			}
			else {
				this._reject("unexpected connection status: " + event.status);
			}
		});
		const promise = super.run();
		this.subscribeToUserChannel();
		this._didSubscribe = true;
		return promise;
	}
}