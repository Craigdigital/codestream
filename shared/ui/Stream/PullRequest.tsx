import React, { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { CodeStreamState } from "../store";
import { Button } from "../src/components/Button";
import styled from "styled-components";
import { CSMe } from "@codestream/protocols/api";
import { isFeatureEnabled } from "../store/apiVersioning/reducer";
import { CreateCodemarkIcons } from "./CreateCodemarkIcons";
import ScrollBox from "./ScrollBox";
import Icon from "./Icon";
import { Tabs, Tab } from "../src/components/Tabs";
import Timestamp from "./Timestamp";
import copy from "copy-to-clipboard";
import MessageInput from "./MessageInput";
import Tooltip from "./Tooltip";
import { Headshot, PRHeadshot } from "../src/components/Headshot";
import { HeadshotName, PRHeadshotName } from "../src/components/HeadshotName";
import { MarkdownText } from "./MarkdownText";
import { Link } from "./Link";
import Tag from "./Tag";
import { setCurrentPullRequest } from "../store/context/actions";
import CancelButton from "./CancelButton";
import { useDidMount } from "../utilities/hooks";
import { HostApi } from "../webview-api";
import {
	CreatePullRequestCommentAndCloseRequest,
	CreatePullRequestCommentRequest,
	ExecuteThirdPartyTypedRequest,
	FetchThirdPartyPullRequestPullRequest,
	ExecuteThirdPartyTypedType,
	FetchThirdPartyPullRequestRequestType,
	FetchThirdPartyPullRequestResponse,
	MergeMethod,
	MergePullRequestRequest
} from "@codestream/protocols/agent";
import { markdownify } from "./Markdowner";
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
	PRContent,
	PRConversation,
	PRComment,
	PRCommentCard,
	PRCommentHeader,
	PRActionIcons,
	PRCommentBody,
	PRCommit,
	PRFoot,
	PRSidebar,
	PRSection
} from "./PullRequestComponents";
import { ButtonRow } from "./StatusPanel";
import { PullRequestTimelineItems } from "./PullRequestTimelineItems";
import { LoadingIndicator } from "react-select/src/components/indicators";
import { LoadingMessage } from "../src/components/LoadingMessage";
import { Modal } from "./Modal";

const Root = styled.div`
	${Tab} {
		font-size: 13px;
		.icon {
			// vertical-align: -2px;
			display: inline-block;
			margin: 0 5px;
		}
	}
	@media only screen and (max-width: 700px) {
		.wide-text {
			display: none;
		}
	}
`;

export const PullRequest = () => {
	const dispatch = useDispatch();
	const derivedState = useSelector((state: CodeStreamState) => {
		const currentUser = state.users[state.session.userId!] as CSMe;
		const team = state.teams[state.context.currentTeamId];
		const blameMap = team.settings ? team.settings.blameMap : {};
		const skipGitEmailCheck = state.preferences.skipGitEmailCheck;
		const addBlameMapEnabled = isFeatureEnabled(state, "addBlameMap");

		return {
			currentUser,
			currentPullRequestId: state.context.currentPullRequestId,
			blameMap,
			team,
			skipGitEmailCheck,
			addBlameMapEnabled
		};
	});

	const [text, setText] = useState("");
	const [activeTab, setActiveTab] = useState(1);
	const [ghRepo, setGhRepo] = useState<any>({});
	const [isLoadingComment, setIsLoadingComment] = useState(false);
	const [isLoadingCommentAndClose, setIsLoadingCommentAndClose] = useState(false);

	const [pr, setPr] = useState<FetchThirdPartyPullRequestPullRequest | undefined>();
	const { team, currentUser } = derivedState;

	const exit = async () => {
		await dispatch(setCurrentPullRequest());
	};

	const onCommentClick = async e => {
		setIsLoadingComment(true);
		await HostApi.instance.send(
			new ExecuteThirdPartyTypedType<CreatePullRequestCommentRequest, any>(),
			{
				method: "createPullRequestComment",
				providerId: "github*com",
				params: {
					pullRequestId: derivedState.currentPullRequestId!,
					text: text
				}
			}
		);
		setText("");
		fetch();
	};

	const onCommentAndCloseClick = async e => {
		setIsLoadingCommentAndClose(true);
		await HostApi.instance.send(
			new ExecuteThirdPartyTypedType<CreatePullRequestCommentAndCloseRequest, any>(),
			{
				method: "createPullRequestCommentAndClose",
				providerId: "github*com",
				params: {
					pullRequestId: derivedState.currentPullRequestId!,
					text: text
				}
			}
		);
		setText("");
		fetch();
	};

	const fetch = async () => {
		const r = (await HostApi.instance.send(FetchThirdPartyPullRequestRequestType, {
			providerId: "github*com",
			pullRequestId: derivedState.currentPullRequestId!
		})) as FetchThirdPartyPullRequestResponse;
		setGhRepo(r.repository);
		setPr(r.repository.pullRequest);
		setIsLoadingComment(false);
	};

	useDidMount(() => {
		fetch();
	});

	const mergePullRequest = async (options: { mergeMethod: MergeMethod }) => {
		await HostApi.instance.send(
			new ExecuteThirdPartyTypedType<MergePullRequestRequest, boolean>(),
			{
				method: "mergePullRequest",
				providerId: "github*com",
				params: {
					pullRequestId: derivedState.currentPullRequestId!,
					mergeMethod: options.mergeMethod
				}
			}
		);
		fetch();
	};

	console.warn(pr);
	if (!pr) {
		return (
			<Modal verticallyCenter>
				<LoadingMessage>Loading Pull Request...</LoadingMessage>
			</Modal>
		);
	} else {
		const statusIcon = "git-merge";
		const action = pr.merged ? "merged " : "wants to merge ";
		const numParticpants = ((pr.participants && pr.participants.nodes) || []).length;
		const participantsLabel = `${numParticpants} Participant${numParticpants == 1 ? "" : "s"}`;
		return (
			<Root className="panel full-height">
				<CreateCodemarkIcons narrow />
				<PRHeader>
					<PRTitle>
						{pr.title} <Link href={pr.url}>#{pr.number}</Link>
						<CancelButton onClick={exit} />
					</PRTitle>
					<PRStatus>
						<PRStatusButton>
							<Icon name={statusIcon} />
							{pr.state && pr.state.toLowerCase()}
						</PRStatusButton>
						<PRStatusMessage>
							<PRAuthor>{pr.author.login}</PRAuthor>
							<PRAction>
								{action} {pr.commits && pr.commits.totalCount} commits into{" "}
								<PRBranch>{pr.baseRefName}</PRBranch> from <PRBranch>{pr.headRefName}</PRBranch>
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
					</PRStatus>
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
						{/* 
					<PRPlusMinus>
						<span className="added">+{pr.linesAdded}</span>{" "}
						<span className="deleted">-{pr.linesDeleted}</span>
					</PRPlusMinus>
					*/}
					</Tabs>
				</PRHeader>
				<ScrollBox>
					<div className="channel-list vscroll">
						<PRContent>
							<div className="main-content">
								<PRConversation>
									{/* in the GH data model, the top box is part of the pr, rather than the timeline */}
									<PRComment style={{ marginTop: "10px" }}>
										<PRHeadshot person={pr.author} size={40} />
										<PRCommentCard>
											<PRCommentHeader>
												<PRAuthor>{pr.author.login}</PRAuthor> commented{" "}
												<Timestamp time={pr.createdAt!} relative />
												<PRActionIcons>
													<div className="member">Member</div>
													<Icon name="smiley" />
													<Icon name="kebab-horizontal" />
												</PRActionIcons>
											</PRCommentHeader>
											<PRCommentBody
												dangerouslySetInnerHTML={{
													__html: markdownify(pr.body)
												}}
											></PRCommentBody>
										</PRCommentCard>
									</PRComment>
									<PullRequestTimelineItems pr={pr} />
									<PRFoot />
								</PRConversation>
								<PRComment>
									{/* 
							<PRStatusIcon>
									<Icon name={statusIcon}  />
								</PRStatusIcon>
								*/}
									<PRCommentCard>
										{!pr.merged && pr.mergeable === "MERGEABLE" && pr.state !== "CLOSED" && (
											<div>
												<p>This branch has no conflicts with the base branch when rebasing</p>
												<p>Rebase and merge can be performed automatically.</p>
												<ButtonRow>
													<div style={{ textAlign: "left", flexGrow: 1 }}>
														<Tooltip
															title={
																<span>
																	All commits from this branch will be added to the base branch via
																	a merge commit.
																	{!ghRepo.mergeCommitAllowed && (
																		<>
																			<br />
																			<small>Not enabled for this repository</small>
																		</>
																	)}
																</span>
															}
															placement="bottomRight"
															delay={1}
														>
															<Button
																disabled={!ghRepo.mergeCommitAllowed}
																onClick={e => mergePullRequest({ mergeMethod: "MERGE" })}
															>
																Create a merge commit
															</Button>
														</Tooltip>
														<Button
															disabled={!ghRepo.squashMergeAllowed}
															onClick={e => mergePullRequest({ mergeMethod: "SQUASH" })}
														>
															Squash and merge
														</Button>
														<Button
															disabled={!ghRepo.rebaseMergeAllowed}
															onClick={e => mergePullRequest({ mergeMethod: "REBASE" })}
														>
															Rebase and merge
														</Button>
													</div>
												</ButtonRow>
											</div>
										)}
										{!pr.merged && pr.mergeable === "CONFLICTING" && (
											<div>This branch has conflicts that must be resolved</div>
										)}
										{!pr.merged && pr.mergeable === "UNKNOWN" && pr.state === "CLOSED" && (
											<div>This pull request is closed</div>
										)}
										{!pr.merged && pr.state === "CLOSED" && <div>Pull request is closed</div>}
										{pr.merged && <div>Pull request successfully merged and closed</div>}
									</PRCommentCard>
								</PRComment>
								<PRComment>
									<Headshot size={40} person={currentUser}></Headshot>
									<PRCommentCard>
										<div
											style={{ margin: "5px 0 0 0", border: "1px solid var(--base-border-color)" }}
										>
											<MessageInput
												multiCompose
												text={text}
												placeholder="Add Comment..."
												onChange={setText}
											/>
										</div>
										<ButtonRow>
											<div style={{ textAlign: "right", flexGrow: 1 }}>
												<Button
													isLoading={isLoadingCommentAndClose}
													onClick={onCommentAndCloseClick}
												>
													Close and comment
												</Button>
												<Tooltip
													title={
														<span>
															Submit Comment
															<span className="keybinding extra-pad">
																{navigator.appVersion.includes("Macintosh") ? "⌘" : "Alt"} ENTER
															</span>
														</span>
													}
													placement="bottomRight"
													delay={1}
												>
													<Button isLoading={isLoadingComment} onClick={onCommentClick}>
														Comment
													</Button>
												</Tooltip>
											</div>
										</ButtonRow>
									</PRCommentCard>
								</PRComment>
							</div>
							<PRSidebar>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Reviewers
									</h1>
									<HeadshotName person={currentUser} />
								</PRSection>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Assignees
									</h1>
									{pr.assignees && pr.assignees.nodes.length > 0
										? pr.assignees.nodes.map((_: any) => <PRHeadshotName person={_} size={20} />)
										: "None yet"}
								</PRSection>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Labels
									</h1>
									{pr.labels &&
										pr.labels.nodes.map(_ => <Tag tag={{ label: _.name, color: `#${_.color}` }} />)}
								</PRSection>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Projects
									</h1>
									None yet
								</PRSection>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Milestone
									</h1>
									{pr.milestone ? <div>{pr.milestone.title}</div> : "No milestone"}
								</PRSection>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Linked Issues
									</h1>
									None yet
								</PRSection>
								<PRSection>
									<h1>
										<Icon name="gear" className="settings clickable" onClick={() => {}} />
										Notifications
									</h1>
									<Button variant="secondary">
										<Icon name="mute" /> Unsubscribe
									</Button>
								</PRSection>
								<PRSection>
									<h1>{participantsLabel}</h1>
									{pr.participants &&
										pr.participants.nodes.map((_: any) => (
											<PRHeadshot display="inline-block" person={_} size={20} />
										))}
								</PRSection>
								<PRSection style={{ borderBottom: "none" }}>
									<h1>
										<Icon name="lock" className="clickable" onClick={() => {}} /> Lock Conversation
									</h1>
								</PRSection>
							</PRSidebar>
						</PRContent>
					</div>
				</ScrollBox>
			</Root>
		);
	}
};
