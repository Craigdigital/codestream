"use strict";

import { expect } from "chai";
require("mocha").describe;
require("mocha").it;
import { Parser } from "../../../../src/managers/stackTraceParsers/javascriptStackTraceParser";

describe("javascriptStackTraceParser", () => {
	/* 
	This test is not fully functional until we can get a real stack trace back from NR1, instead of using our
	extension to pluck it off the web page ... since it is truncated when we pluck it. 
	Instead we leave in our (incorrect) parser to account for the truncated stack, for demo purposes
	*/
	/*
	it("stack1", () => {
		const str = `TypeError: this.request.csrfToken is not a function
at LinkNewRelicRequest.createLauncherModel (/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/modules/web/link_newrelic_request.js:81:23)
at LinkNewRelicRequest.render (/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/modules/web/link_newrelic_request.js:39:33)
at LinkNewRelicRequest.process (/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/modules/web/link_newrelic_request.js:23:16)
at LinkNewRelicRequest.executePhase (/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/lib/api_server/api_request.js:62:20)
at LinkNewRelicRequest.fulfill (/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/lib/api_server/api_request.js:138:16)
at runMicrotasks (<anonymous>)
at processTicksAndRejections (internal/process/task_queues.js:94:5)`;

		const result = Parser(str);
		expect(result).to.deep.equals({
			lines: [
				{
					fileFullPath:
						"/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/modules/web/link_newrelic_request.js",
					method: "LinkNewRelicRequest.createLauncherModel",
					arguments: [],
					line: 81,
					column: 23
				},
				{
					fileFullPath:
						"/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/modules/web/link_newrelic_request.js",
					method: "LinkNewRelicRequest.render",
					arguments: [],
					line: 39,
					column: 33
				},
				{
					fileFullPath:
						"/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/modules/web/link_newrelic_request.js",
					method: "LinkNewRelicRequest.process",
					arguments: [],
					line: 23,
					column: 16
				},
				{
					fileFullPath:
						"/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/lib/api_server/api_request.js",
					method: "LinkNewRelicRequest.executePhase",
					arguments: [],
					line: 62,
					column: 20
				},
				{
					fileFullPath:
						"/Users/cstryker/dev/sandboxes/csdemo/codestream-server/api_server/lib/api_server/api_request.js",
					method: "LinkNewRelicRequest.fulfill",
					arguments: [],
					line: 138,
					column: 16
				},
				{
					fileFullPath: "<anonymous>",
					method: "runMicrotasks",
					arguments: [],
					line: undefined,
					column: undefined
				},
				{
					fileFullPath: "internal/process/task_queues.js",
					method: "processTicksAndRejections",
					arguments: [],
					line: 94,
					column: 5
				}
			],
			header: "TypeError: this.request.csrfToken is not a function",
			error: "this.request.csrfToken is not a function"
		});
	});
	*/
});