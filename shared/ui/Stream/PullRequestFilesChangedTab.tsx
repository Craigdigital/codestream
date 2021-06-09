import React, { useState } from "react";
import { isFeatureEnabled } from "../store/apiVersioning/reducer";
import Icon from "./Icon";
import Timestamp from "./Timestamp";
import Tooltip from "./Tooltip";
import { PRHeadshotName } from "../src/components/HeadshotName";
import { PRContent, PRSelectorButtons } from "./PullRequestComponents";
import styled from "styled-components";
import { ExecuteThirdPartyTypedType } from "@codestream/protocols/agent";
import { useDidMount } from "../utilities/hooks";
import { HostApi } from "../webview-api";
import { useSelector, useDispatch } from "react-redux";
import { CodeStreamState } from "../store";
import { PullRequestFilesChanged } from "./PullRequestFilesChanged";
import { FileStatus } from "@codestream/protocols/api";
import { LoadingMessage } from "../src/components/LoadingMessage";
import { PRCommitCard } from "./PullRequestCommitsTab";
import * as Path from "path-browserify";
import { prettyPrintOne } from "code-prettify";
import { escapeHtml } from "../utils";
import { setUserPreference } from "./actions";

const PRCommitContent = styled.div`
	margin: 0 20px 20px 40px;
	position: relative;
`;

const PRDiffHunks = styled.div`
	font-family: Menlo, Consolas, "DejaVu Sans Mono", monospace;
	white-space: pre;
}
`;

const PRDiffHunk = styled.div`
	overflow-x: auto;
	max-width: 100%;
	font-size: 12px;
	border: 1px solid var(--base-border-color);
	border-radius: 5px;
	overflow: hidden;
	margin: 0 0 20px 0;
	pre {
		display: inline;
		white-space: pre !important;
		margin: 0;
	}
	pre > div {
		width: 100%;
		padding: 3px 10px;
		// color: #24292e;
		// background: #fff;
		> span.linenum {
			opacity: 0.5;
		}
		margin: 0;
	}
	.added {
		background: #e6ffed;
		background: rgba(150, 255, 0, 0.1);
	}
	.deleted {
		background: #ffeef0;
		background: rgba(255, 0, 0, 0.15);
	}
	.header {
		background: rgba(0, 150, 255, 0.1);
	}
	h1 {
		font-size: 12px;
		font-weight: normal;
		margin: 0;
		padding: 10px;
		background: var(--base-background-color);
		border-bottom: 1px solid var(--base-border-color);
	}
`;

const STATUS_MAP = {
	modified: FileStatus.modified
};

export const PullRequestFilesChangedTab = props => {
	const { pr, ghRepo } = props;
	const dispatch = useDispatch();
	const derivedState = useSelector((state: CodeStreamState) => {
		return {
			pullRequestFilesChangedMode: state.preferences.pullRequestFilesChangedMode || "files",
			currentPullRequestId: state.context.currentPullRequestId
		};
	});

	const [isLoading, setIsLoading] = useState(true);
	const [filesChanged, setFilesChanged] = useState<any[]>([]);

	const setMode = mode => {
		dispatch(setUserPreference(["pullRequestFilesChangedMode"], mode));
	};

	useDidMount(() => {
		setIsLoading(true);
		(async () => {
			const data = await HostApi.instance.send(new ExecuteThirdPartyTypedType<any, any>(), {
				method: "getPullRequestFilesChanged",
				providerId: pr.providerId,
				params: {
					pullRequestId: derivedState.currentPullRequestId
				}
			});
			const filesChanged = data.map(_ => {
				return {
					..._,
					linesAdded: _.additions,
					linesRemoved: _.deletions,
					file: _.filename,
					sha: _.sha,
					status: STATUS_MAP[_.status]
				};
			});
			setFilesChanged(filesChanged);
			setIsLoading(false);
		})();
	});

	if (isLoading)
		return (
			<div style={{ marginTop: "100px" }}>
				<LoadingMessage>Loading Changed Files...</LoadingMessage>
			</div>
		);

	if (!filesChanged || !filesChanged.length) return null;

	const renderPatch = (patch: string, filename: string) => {
		if (!patch) return null;
		let leftLine;
		let rightLine;
		let width;

		let extension = Path.extname(filename).toLowerCase();
		if (extension.startsWith(".")) {
			extension = extension.substring(1);
		}

		const renderLineNum = line => (
			<span className="linenum">{(line + "").padStart(width, " ") + "  "}</span>
		);

		const syntaxHighlight = string => {
			const string2 = string.slice(0, 1) + " " + string.slice(1);
			const html = prettyPrintOne(escapeHtml(string2), extension);
			return <pre className="prettyprint" dangerouslySetInnerHTML={{ __html: html }} />;
		};

		return patch.split("\n").map(_ => {
			if (_.indexOf("@@ ") === 0) {
				const matches = _.match(/@@ \-(\d+).*? \+(\d+)/);
				if (matches) {
					leftLine = matches[1];
					rightLine = matches[2];
					width = Math.max(5, rightLine.length + 1);
				}
				return (
					<div className="header">
						{renderLineNum("")}
						{renderLineNum("")}
						<pre className="prettyprint">{_}</pre>
					</div>
				);
			} else if (_.indexOf("+") === 0) {
				rightLine++;
				return (
					<div className="added">
						{renderLineNum("")}
						{renderLineNum(rightLine)}
						{syntaxHighlight(_)}
					</div>
				);
			} else if (_.indexOf("-") === 0) {
				leftLine++;
				return (
					<div className="deleted">
						{renderLineNum(leftLine)}
						{renderLineNum("")}
						{syntaxHighlight(_)}
					</div>
				);
			} else {
				leftLine++;
				rightLine++;
				return (
					<div>
						{renderLineNum(leftLine)}
						{renderLineNum(rightLine)}
						{syntaxHighlight(_)}
					</div>
				);
			}
		});
	};

	const mode = derivedState.pullRequestFilesChangedMode;

	return (
		<PRCommitContent>
			<PRSelectorButtons>
				<span className={mode == "files" ? "selected" : ""} onClick={() => setMode("files")}>
					Files
				</span>
				<span className={mode == "hunks" ? "selected" : ""} onClick={() => setMode("hunks")}>
					Diff Hunks
				</span>
			</PRSelectorButtons>
			<div style={{ height: "10px" }} />
			{mode == "files" ? (
				<PullRequestFilesChanged pr={pr} filesChanged={filesChanged} />
			) : (
				<PRDiffHunks>
					{filesChanged.map(_ => {
						return (
							<PRDiffHunk>
								<h1>{_.filename}</h1>
								<pre>{renderPatch(_.patch, _.filename)}</pre>
							</PRDiffHunk>
						);
					})}
				</PRDiffHunks>
			)}
		</PRCommitContent>
	);

	// return (
	// 	<PRCommitContent>
	// 		<div>
	// 		</div>
	// 	</PRCommitContent>
	// );
};
