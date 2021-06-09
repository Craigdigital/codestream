import React, { useState, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { CodeStreamState } from "../store";
import styled from "styled-components";
import { CSMe } from "@codestream/protocols/api";
import { CreateCodemarkIcons } from "./CreateCodemarkIcons";
import ScrollBox from "./ScrollBox";
import Icon from "./Icon";
import { Tabs, Tab } from "../src/components/Tabs";
import Timestamp from "./Timestamp";
import copy from "copy-to-clipboard";
import { Link } from "./Link";
import { setCurrentPullRequest, setCurrentReview } from "../store/context/actions";
import CancelButton from "./CancelButton";
import { useDidMount } from "../utilities/hooks";
import { HostApi } from "../webview-api";
import {
	FetchThirdPartyPullRequestPullRequest,
	GetReposScmRequestType,
	ReposScm,
	ExecuteThirdPartyTypedType,
	SwitchBranchRequestType
} from "@codestream/protocols/agent";
import {
	PRHeader,
	PRTitle,
	PRStatus,
	PRStatusButton,
	PRStatusMessage,
	PRAuthor,
	PRAction,
	PRBranch,
	PRBadge,
	PRPlusMinus,
	PREditTitle,
	PRActionButtons,
	PRCommentCard,
	PRSubmitReviewButton
} from "./PullRequestComponents";
import { LoadingMessage } from "../src/components/LoadingMessage";
import { Modal } from "./Modal";
import { bootstrapReviews } from "../store/reviews/actions";
import { PullRequestConversationTab } from "./PullRequestConversationTab";
import { PullRequestCommitsTab } from "./PullRequestCommitsTab";
import * as reviewSelectors from "../store/reviews/reducer";
import { PullRequestFilesChangedTab } from "./PullRequestFilesChangedTab";
import { FloatingLoadingMessage } from "../src/components/FloatingLoadingMessage";
import { Button } from "../src/components/Button";
import MessageInput from "./MessageInput";
import { RadioGroup, Radio } from "../src/components/RadioGroup";
import Tooltip from "./Tooltip";
import { PullRequestFinishReview } from "./PullRequestFinishReview";
import {
	getPullRequestConversationsFromProvider,
	clearPullRequestFiles,
	getPullRequestConversations
} from "../store/providerPullRequests/actions";

export const WidthBreakpoint = "630px";

const Root = styled.div`
	${Tabs} {
		margin: 10px 0;
	}
	${Tab} {
		font-size: 13px;
		white-space: nowrap;
		padding: 0 5px 10px 5px;
		.icon {
			// vertical-align: -2px;
			display: inline-block;
			margin: 0 5px;
		}
	}
	@media only screen and (max-width: ${WidthBreakpoint}) {
		.wide-text {
			display: none;
		}
	}
	a {
		text-decoration: none;
		&:hover {
			color: var(--text-color-info);
		}
	}
	.mine {
		background: rgba(90, 127, 255, 0.08);
	}
	.codestream .stream & ul.contains-task-list {
		margin: 0 !important;
		padding: 0 !important;
		white-space: normal;
		li.task-list-item {
			margin: 0 !important;
			padding: 3px 0 3px 30px !important;
			list-style: none;
			input {
				margin-left: -30px;
			}
		}
	}
`;

const EMPTY_HASH = {};
const EMPTY_ARRAY = [];

export const PullRequest = () => {
	const dispatch = useDispatch();
	const derivedState = useSelector((state: CodeStreamState) => {
		const currentUser = state.users[state.session.userId!] as CSMe;
		const team = state.teams[state.context.currentTeamId];
		return {
			providerPullRequests: state.providerPullRequests.pullRequests,
			reviewsState: state.reviews,
			reviews: reviewSelectors.getAllReviews(state),
			currentUser,
			currentPullRequestId: state.context.currentPullRequestId,
			composeCodemarkActive: state.context.composeCodemarkActive,
			team,
			textEditorUri: state.editorContext.textEditorUri,
			reposState: state.repos
		};
	});

	const [activeTab, setActiveTab] = useState(1);
	const [ghRepo, setGhRepo] = useState<any>(EMPTY_HASH);
	const [isLoadingPR, setIsLoadingPR] = useState(false);
	const [isLoadingMessage, setIsLoadingMessage] = useState("");
	const [pr, setPr] = useState<FetchThirdPartyPullRequestPullRequest | undefined>();
	const [openRepos, setOpenRepos] = useState<ReposScm[]>(EMPTY_ARRAY);
	const [editingTitle, setEditingTitle] = useState(false);
	const [savingTitle, setSavingTitle] = useState(false);
	const [title, setTitle] = useState("");

	const [finishReviewOpen, setFinishReviewOpen] = useState(false);

	const exit = async () => {
		await dispatch(setCurrentPullRequest());
	};

	const _assignState = pr => {
		if (!pr) return;
		setGhRepo(pr.repository);
		setPr(pr.repository.pullRequest);
		setTitle(pr.repository.pullRequest.title);
		setEditingTitle(false);
		setSavingTitle(false);
		setIsLoadingPR(false);
		setIsLoadingMessage("");
	};

	// FIXME this shouldn't be hard-coded
	const providerId = "github*com";

	useEffect(() => {
		const providerPullRequests = derivedState.providerPullRequests[providerId];
		if (providerPullRequests) {
			let data = providerPullRequests[derivedState.currentPullRequestId!];
			if (data) {
				_assignState(data.conversations);
			}
		}
	}, [derivedState.providerPullRequests]);

	const initialFetch = async (message?: string) => {
		if (message) setIsLoadingMessage(message);
		setIsLoadingPR(true);

		const response = (await dispatch(
			getPullRequestConversations(providerId, derivedState.currentPullRequestId!)
		)) as any;
		_assignState(response);
		if (response) {
			HostApi.instance.track("PR Clicked", {
				Host: response.providerId
			});
		}
	};

	/**
	 * Called after an action that requires us to re-fetch from the provider
	 * @param message
	 */
	const fetch = async (message?: string) => {
		if (message) setIsLoadingMessage(message);
		setIsLoadingPR(true);

		const response = (await dispatch(
			getPullRequestConversationsFromProvider(pr!.providerId, derivedState.currentPullRequestId!)
		)) as any;
		_assignState(response);
	};

	/**
	 * This is called when a user clicks the "reload" button.
	 * with a "hard-reload" we need to refresh the conversation and file data
	 * @param message
	 */
	const reload = async (message?: string) => {
		if (message) setIsLoadingMessage(message);
		setIsLoadingPR(true);
		const response = (await dispatch(
			getPullRequestConversationsFromProvider(pr!.providerId, derivedState.currentPullRequestId!)
		)) as any;
		_assignState(response);

		// just clear the files data -- it will be fetched if necessary (since it has its own api call)
		dispatch(clearPullRequestFiles(providerId, derivedState.currentPullRequestId!));
	};

	const checkout = async () => {
		if (!pr) return;
		const currentRepo = Object.values(derivedState.reposState).find(
			_ => _.name === pr.repository.name
		);
		const result = await HostApi.instance.send(SwitchBranchRequestType, {
			branch: pr!.headRefName,
			repoId: currentRepo ? currentRepo.id : ""
		});
		if (result.error) {
			console.warn("ERROR FROM SET BRANCH: ", result.error);
			return;
		}
		fetch("Reloading...");
	};

	const saveTitle = async () => {
		setIsLoadingMessage("Saving Title...");
		setSavingTitle(true);

		await HostApi.instance.send(new ExecuteThirdPartyTypedType<any, any>(), {
			method: "updatePullRequestTitle",
			providerId: pr!.providerId,
			params: {
				pullRequestId: derivedState.currentPullRequestId!,
				title
			}
		});
		fetch();
	};

	const getROpenRepos = async () => {
		const response = await HostApi.instance.send(GetReposScmRequestType, {
			inEditorOnly: true
		});
		if (response && response.repositories) {
			setOpenRepos(response.repositories);
		}
	};

	const linkHijacker = (e: any) => {
		if (e && e.target.tagName === "A" && e.target.text === "Changes reviewed on CodeStream") {
			const review = Object.values(derivedState.reviews).find(
				_ => _.permalink === e.target.href.replace("?src=GitHub", "")
			);
			if (review) {
				e.preventDefault();
				e.stopPropagation();
				dispatch(setCurrentPullRequest(""));
				dispatch(setCurrentReview(review.id));
			}
		}
	};

	useEffect(() => {
		document.addEventListener("click", linkHijacker);
		return () => {
			document.removeEventListener("click", linkHijacker);
		};
	}, [derivedState.reviews]);

	const numComments = React.useMemo(() => {
		if (!pr || !pr.timelineItems || !pr.timelineItems.nodes) return 0;
		const reducer = (accumulator, node) => {
			let count = 0;
			if (!node || !node.__typename) return accumulator;
			const typename = node.__typename;
			if (typename && typename.indexOf("Comment") > -1) count = 1;
			if (typename === "PullRequestReview") {
				// pullrequestreview can have a top-level comment,
				// and multiple comment threads.
				if (node.body) count++; // top-level comment (optional)
				count += node.comments.nodes.length; // threads
				node.comments.nodes.forEach(c => {
					// each thread can have replies
					if (c.replies) count += c.replies.length;
				});
			}
			return count + accumulator;
		};
		return pr.timelineItems.nodes.reduce(reducer, 0);
	}, [pr]);

	useDidMount(() => {
		if (!derivedState.reviewsState.bootstrapped) {
			dispatch(bootstrapReviews());
		}
		initialFetch();
	});

	let interval;
	let intervalCounter = 0;
	useEffect(() => {
		interval && clearInterval(interval);
		if (pr) {
			interval = setInterval(async () => {
				if (intervalCounter >= 120) {
					interval && clearInterval(interval);
					intervalCounter = 0;
					console.warn(`stopped getPullRequestLastUpdated interval counter=${intervalCounter}`);
					return;
				}
				try {
					const response = await HostApi.instance.send(new ExecuteThirdPartyTypedType<any, any>(), {
						method: "getPullRequestLastUpdated",
						providerId: pr.providerId,
						params: {
							pullRequestId: derivedState.currentPullRequestId!
						}
					});

					if (pr && response && response.updatedAt !== pr.updatedAt) {
						console.log(
							"getPullRequestLastUpdated is updating",
							response.updatedAt,
							pr.updatedAt,
							intervalCounter
						);
						intervalCounter = 0;
						reload();
						clearInterval(interval);
					} else {
						intervalCounter++;
					}
				} catch (ex) {
					console.error(ex);
					interval && clearInterval(interval);
				}
			}, 60000); //60000 === 1 minute
		}

		return () => {
			interval && clearInterval(interval);
		};
	}, [pr]);

	console.warn("PR: ", pr);
	// console.warn("REPO: ", ghRepo);
	if (!pr) {
		return (
			<Modal verticallyCenter showGlobalNav>
				<LoadingMessage>Loading Pull Request...</LoadingMessage>
			</Modal>
		);
	} else {
		const statusIcon = pr.state === "OPEN" || pr.state === "CLOSED" ? "pull-request" : "git-merge";
		const action = pr.merged ? "merged " : "wants to merge ";

		// console.log(pr.files);
		// console.log(pr.commits);
		return (
			<Root className="panel full-height">
				<CreateCodemarkIcons narrow onebutton />
				{isLoadingMessage && <FloatingLoadingMessage>{isLoadingMessage}</FloatingLoadingMessage>}
				<PRHeader>
					<PRTitle className={editingTitle ? "editing" : ""}>
						{editingTitle ? (
							<PREditTitle>
								<input
									id="title-input"
									name="title"
									value={title}
									className="input-text control"
									autoFocus
									type="text"
									onChange={e => setTitle(e.target.value)}
									placeholder=""
								/>
								<Button onClick={saveTitle} isLoading={savingTitle}>
									Save
								</Button>
								<Button
									variant="secondary"
									onClick={() => {
										setTitle("");
										setSavingTitle(false);
										setEditingTitle(false);
									}}
								>
									Cancel
								</Button>
							</PREditTitle>
						) : (
							<>
								{title || pr.title}{" "}
								<Tooltip title="Open on GitHub" placement="top">
									<span>
										<Link href={pr.url}>
											#{pr.number}
											<Icon name="link-external" className="open-external" />
										</Link>
									</span>
								</Tooltip>
							</>
						)}
					</PRTitle>
					<PRStatus>
						<PRStatusButton
							disabled
							fullOpacity
							variant={
								pr.isDraft
									? "neutral"
									: pr.state === "OPEN"
									? "success"
									: pr.state === "MERGED"
									? "merged"
									: pr.state === "CLOSED"
									? "destructive"
									: "primary"
							}
						>
							<Icon name={statusIcon} />
							{pr.isDraft ? "Draft" : pr.state ? pr.state.toLowerCase() : ""}
						</PRStatusButton>
						<PRStatusMessage>
							<PRAuthor>{pr.author.login}</PRAuthor>
							<PRAction>
								{action} {pr.commits && pr.commits.totalCount} commits into{" "}
								<Link href={`${pr.repoUrl}/tree/${pr.baseRefName}`}>
									<PRBranch>
										{pr.repository.name}:{pr.baseRefName}
									</PRBranch>
								</Link>
								{" from "}
								<Link href={`${pr.repoUrl}/tree/${pr.headRefName}`}>
									<PRBranch>{pr.headRefName}</PRBranch>
								</Link>{" "}
								<Icon
									title="Copy"
									placement="bottom"
									name="copy"
									className="clickable"
									onClick={e => copy(pr.baseRefName)}
								/>
							</PRAction>
							<Timestamp time={pr.createdAt} relative />
						</PRStatusMessage>
						<PRActionButtons>
							{pr.viewerCanUpdate && (
								<span>
									<Icon
										title="Edit Title"
										trigger={["hover"]}
										delay={1}
										onClick={() => {
											setTitle(pr.title);
											setEditingTitle(true);
										}}
										placement="bottom"
										name="pencil"
									/>
								</span>
							)}
							<span>
								<Icon
									title="Checkout Branch"
									trigger={["hover"]}
									delay={1}
									onClick={checkout}
									placement="bottom"
									name="repo"
								/>
							</span>
							<span>
								<Icon
									title="Reload"
									trigger={["hover"]}
									delay={1}
									onClick={() => reload("Reloading...")}
									placement="bottom"
									className={`${isLoadingPR ? "spin" : ""}`}
									name="refresh"
								/>
							</span>
							<span>
								<CancelButton className="button" title="Close" onClick={exit} />
							</span>
						</PRActionButtons>
					</PRStatus>
					<Tabs style={{ marginTop: 0 }}>
						<Tab onClick={e => setActiveTab(1)} active={activeTab == 1}>
							<Icon name="comment" />
							<span className="wide-text">Conversation</span>
							<PRBadge>{numComments}</PRBadge>
						</Tab>
						<Tab onClick={e => setActiveTab(2)} active={activeTab == 2}>
							<Icon name="git-commit" />
							<span className="wide-text">Commits</span>
							<PRBadge>{pr.commits.totalCount}</PRBadge>
						</Tab>
						{/*
		<Tab onClick={e => setActiveTab(3)} active={activeTab == 3}>
			<Icon name="check" />
			<span className="wide-text">Checks</span>
			<PRBadge>{pr.numChecks}</PRBadge>
		</Tab>
		 */}
						<Tab onClick={e => setActiveTab(4)} active={activeTab == 4}>
							<Icon name="plus-minus" />
							<span className="wide-text">Files Changed</span>
							<PRBadge>{pr.files.totalCount}</PRBadge>
						</Tab>

						{pr.pendingReview ? (
							<PRSubmitReviewButton>
								<Button variant="success" onClick={() => setFinishReviewOpen(!finishReviewOpen)}>
									Finish<span className="wide-text"> review</span>
									<PRBadge>
										{pr.pendingReview.comments ? pr.pendingReview.comments.totalCount : 0}
									</PRBadge>
									<Icon name="chevron-down" />
								</Button>
								{finishReviewOpen && (
									<PullRequestFinishReview
										pr={pr}
										mode="dropdown"
										fetch={fetch}
										setIsLoadingMessage={setIsLoadingMessage}
										setFinishReviewOpen={setFinishReviewOpen}
									/>
								)}
							</PRSubmitReviewButton>
						) : (
							<PRPlusMinus>
								<span className="added">
									+
									{!pr.files
										? 0
										: pr.files.nodes
												.map(_ => _.additions)
												.reduce((acc, val) => acc + val)
												.toString()
												.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
								</span>{" "}
								<span className="deleted">
									-
									{!pr.files
										? 0
										: pr.files.nodes
												.map(_ => _.deletions)
												.reduce((acc, val) => acc + val)
												.toString()
												.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
								</span>
							</PRPlusMinus>
						)}
					</Tabs>
				</PRHeader>
				{!derivedState.composeCodemarkActive && (
					<ScrollBox>
						<div className="channel-list vscroll">
							{activeTab === 1 && (
								<PullRequestConversationTab
									pr={pr}
									ghRepo={ghRepo}
									fetch={fetch}
									setIsLoadingMessage={setIsLoadingMessage}
								/>
							)}
							{activeTab === 2 && <PullRequestCommitsTab pr={pr} ghRepo={ghRepo} fetch={fetch} />}
							{activeTab === 4 && (
								<PullRequestFilesChangedTab
									key="files-changed"
									pr={pr}
									ghRepo={ghRepo}
									fetch={fetch}
								/>
							)}
						</div>
					</ScrollBox>
				)}
			</Root>
		);
	}
};
