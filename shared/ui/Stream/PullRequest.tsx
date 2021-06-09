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
	FetchThirdPartyPullRequestRequestType,
	FetchThirdPartyPullRequestResponse,
	GetReposScmRequestType,
	ReposScm,
	ExecuteThirdPartyTypedType
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
	ButtonRow,
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

export const WidthBreakpoint = "630px";

const Root = styled.div`
	${Tabs} {
		margin: 10px 20px 10px 20px;
	}
	${Tab} {
		font-size: 13px;
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
`;

export const PullRequest = () => {
	const dispatch = useDispatch();
	const derivedState = useSelector((state: CodeStreamState) => {
		const currentUser = state.users[state.session.userId!] as CSMe;
		const team = state.teams[state.context.currentTeamId];
		return {
			reviewsState: state.reviews,
			reviews: reviewSelectors.getAllReviews(state),
			currentUser,
			currentPullRequestId: state.context.currentPullRequestId,
			composeCodemarkActive: state.context.composeCodemarkActive,
			team
		};
	});

	const [activeTab, setActiveTab] = useState(1);
	const [ghRepo, setGhRepo] = useState<any>({});
	const [isLoadingPR, setIsLoadingPR] = useState(false);
	const [isLoadingMessage, setIsLoadingMessage] = useState("");
	const [pr, setPr] = useState<FetchThirdPartyPullRequestPullRequest | undefined>();
	const [openRepos, setOpenRepos] = useState<ReposScm[]>([]);
	const [editingTitle, setEditingTitle] = useState(false);
	const [savingTitle, setSavingTitle] = useState(false);
	const [title, setTitle] = useState("");

	const [finishReviewOpen, setFinishReviewOpen] = useState(false);
	const [reviewText, setReviewText] = useState("");
	const [reviewType, setReviewType] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">(
		"COMMENT"
	);

	const exit = async () => {
		await dispatch(setCurrentPullRequest());
	};

	const fetch = async (message?: string) => {
		if (message) setIsLoadingMessage(message);
		setIsLoadingPR(true);
		const r = (await HostApi.instance.send(FetchThirdPartyPullRequestRequestType, {
			providerId: "github*com",
			pullRequestId: derivedState.currentPullRequestId!
		})) as FetchThirdPartyPullRequestResponse;
		setGhRepo(r.repository);
		setPr(r.repository.pullRequest);
		setTitle(r.repository.pullRequest.title);
		setEditingTitle(false);
		setSavingTitle(false);
		setIsLoadingPR(false);
		setIsLoadingMessage("");
	};

	const _submitPullRequestReview = async (
		type: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
		text?: string
	) => {
		await HostApi.instance.send(new ExecuteThirdPartyTypedType<any, any>(), {
			method: "submitReview",
			providerId: "github*com",
			params: {
				pullRequestId: derivedState.currentPullRequestId!,
				eventType: type,
				text: text
			}
		});
		return fetch();
	};

	const submitReview = async e => {
		await _submitPullRequestReview(reviewType, reviewText);
	};

	const deletePullRequestReview = async (e, id) => {
		await HostApi.instance.send(new ExecuteThirdPartyTypedType<any, any>(), {
			method: "deletePullRequestReview",
			providerId: "github*com",
			params: {
				pullRequestId: derivedState.currentPullRequestId!,
				pullRequestReviewId: id
			}
		});
		fetch();
	};

	const checkout = async () => {
		//
	};

	const saveTitle = async () => {
		setIsLoadingMessage("Saving Title...");
		setSavingTitle(true);

		await HostApi.instance.send(new ExecuteThirdPartyTypedType<any, any>(), {
			method: "updatePullRequestTitle",
			providerId: "github*com",
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

	useDidMount(() => {
		if (!derivedState.reviewsState.bootstrapped) {
			dispatch(bootstrapReviews());
		}
		fetch();
	});

	console.warn("PR: ", pr);
	console.warn("REPO: ", ghRepo);
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
								{title || pr.title} <Link href={pr.url}>#{pr.number}</Link>
							</>
						)}
					</PRTitle>
					<PRStatus>
						<PRStatusButton
							variant={
								pr.state === "OPEN"
									? "success"
									: pr.state === "MERGED"
									? "merged"
									: pr.state === "CLOSED"
									? "destructive"
									: "primary"
							}
						>
							<Icon name={statusIcon} />
							{pr.state && pr.state.toLowerCase()}
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
						{pr && pr.pendingReview && (
							<PRSubmitReviewButton>
								<Button variant="success" onClick={() => setFinishReviewOpen(!finishReviewOpen)}>
									Finish your review
									<PRBadge>3</PRBadge>
									<Icon name="chevron-down" />
								</Button>
								{finishReviewOpen && (
									<>
										<PRCommentCard className="add-comment no-arrow">
											<div
												style={{
													margin: "5px 0 15px 0",
													border: "1px solid var(--base-border-color)"
												}}
											>
												<MessageInput
													autoFocus
													multiCompose
													text={reviewText}
													placeholder="Leave a comment"
													onChange={setReviewText}
													onSubmit={submitReview}
												/>
											</div>
											<RadioGroup
												name="approval"
												selectedValue={reviewType}
												onChange={value => setReviewType(value)}
											>
												<Radio value={"COMMENT"}>
													Comment
													<div className="subtle">
														Submit general feedback without explicit approval.
													</div>
												</Radio>
												<Radio disabled={pr.viewerDidAuthor} value={"APPROVE"}>
													<Tooltip
														title={
															pr.viewerDidAuthor
																? "Pull request authors can't approve their own pull request"
																: ""
														}
														placement="top"
													>
														<span>
															Approve
															<div className="subtle">
																Submit feedback and approve merging these changes.{" "}
															</div>
														</span>
													</Tooltip>
												</Radio>
												<Radio disabled={pr.viewerDidAuthor} value={"REQUEST_CHANGES"}>
													<Tooltip
														title={
															pr.viewerDidAuthor
																? "Pull request authors can't request changes on their own pull request"
																: ""
														}
														placement="top"
													>
														<span>
															{" "}
															Request Changes
															<div className="subtle">
																Submit feedback that must be addressed before merging.
															</div>
														</span>
													</Tooltip>
												</Radio>
											</RadioGroup>
											{/* 
											<a onClick={submitPullRequestReview}>comment</a>{" "}
											<a onClick={approvePullRequest}>approve</a>{" "}
											<a onClick={requestChangesToPullRequest}>request changes</a>{" "}
											<a onClick={e => deletePullRequestReview(e, pr.pendingReview.id)}>
												delete review
											</a>*/}
											<ButtonRow>
												<Button onClick={submitReview}>Submit Review</Button>
												<div className="subtle" style={{ margin: "10px 0 0 10px" }}>
													3 pending comments
												</div>
											</ButtonRow>
										</PRCommentCard>
									</>
								)}
							</PRSubmitReviewButton>
						)}
						{pr && !pr.pendingReview && (
							<PRActionButtons>
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
										onClick={() => fetch("Reloading...")}
										placement="bottom"
										className={`${isLoadingPR ? "spin" : ""}`}
										name="refresh"
									/>
								</span>
								<span>
									<CancelButton className="button" title="Close" onClick={exit} />
								</span>
							</PRActionButtons>
						)}
					</PRStatus>
				</PRHeader>
				{!derivedState.composeCodemarkActive && (
					<ScrollBox>
						<div className="channel-list vscroll">
							<Tabs style={{ marginTop: 0 }}>
								<Tab onClick={e => setActiveTab(1)} active={activeTab == 1}>
									<Icon name="comment" />
									<span className="wide-text">Conversation</span>
									<PRBadge>
										{pr.timelineItems && pr.timelineItems.nodes
											? pr.timelineItems.nodes.filter(
													_ => _.__typename && _.__typename.indexOf("Comment") > -1
											  ).length
											: 0}
									</PRBadge>
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
							</Tabs>
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
