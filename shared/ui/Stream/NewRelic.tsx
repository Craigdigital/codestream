import React, { useEffect, useRef, useState } from "react";
import { useSelector, useDispatch, shallowEqual } from "react-redux";
import { PaneHeader, PaneBody, PaneState, PaneNode, PaneNodeName } from "../src/components/Pane";
import { WebviewPanels } from "../ipc/webview.protocol.common";
import { CodeStreamState } from "../store";
import { isConnected } from "../store/providers/reducer";
import { runNRQL, setNewRelicData } from "../store/newrelic/actions";
import { TextInput } from "../Authentication/TextInput";
import { Button } from "../src/components/Button";
import { FormattedMessage } from "react-intl";
import { IntegrationButtons, Provider } from "./IntegrationsPanel";
import { configureAndConnectProvider } from "../store/providers/actions";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import { setUserPreference } from "./actions";
import { Linkish, Row } from "./CrossPostIssueControls/IssueDropdown";
import { HostApi } from "../webview-api";
import { OpenUrlRequestType } from "@codestream/protocols/webview";
import Timestamp from "./Timestamp";
import styled from "styled-components";

interface Props {
	paneState: PaneState;
}

const EMPTY_HASH = {};

const Root = styled.div`
	height: 100%;
	.pr-row {
		padding-left: 40px;
		.selected-icon {
			left: 20px;
		}
	}
	${PaneNode} ${PaneNode} {
		${PaneNodeName} {
			padding-left: 40px;
		}
		.pr-row {
			padding-left: 60px;
			.selected-icon {
				left: 40px;
			}
		}
	}
	#pr-search-input-wrapper .pr-search-input {
		margin: -3px 0 !important;
		padding: 3px 0 !important;
		&:focus {
			padding: 3px 5px !important;
		}
		&:focus::placeholder {
			opacity: 0 !important;
		}
		&:not(:focus) {
			cursor: pointer;
			border: none !important;
		}
		&::placeholder {
			opacity: 1 !important;
			color: var(--text-color);
		}
		&:hover::placeholder {
			color: var(--text-color-highlight);
		}
	}
	${PaneNode} .pr-search {
		padding-left: 40px;
	}
	div.go-pr {
		padding: 0;
		margin-left: auto;
		button {
			margin-top: 0px;
		}
	}
`;

const ErrorRow = props => {
	return (
		<Row className="pr-row" onClick={() => {}}>
			<div>
				<Icon name="alert" />
			</div>
			<div>
				<span>{props.title}</span>
			</div>
			<div className="icons">
				<span
					onClick={e => {
						e.preventDefault();
						e.stopPropagation();
						HostApi.instance.send(OpenUrlRequestType, {
							url: ""
						});
					}}
				>
					<Icon
						name="globe"
						className="clickable"
						title="View on New Relic One"
						placement="bottomLeft"
						delay={1}
					/>
				</span>
				<Timestamp time={1629267895000} relative abbreviated />
			</div>
		</Row>
	);
};
export const NewRelic = React.memo((props: Props) => {
	const dispatch = useDispatch();
	const derivedState = useSelector((state: CodeStreamState) => {
		const { providers = {}, newRelicData, preferences } = state;
		const newRelicIsConnected =
			providers["newrelic*com"] && isConnected(state, { id: "newrelic*com" });
		const data = (newRelicData && newRelicData.data) || undefined;
		const hiddenPaneNodes = preferences.hiddenPaneNodes || EMPTY_HASH;
		return {
			newRelicIsConnected,
			newRelicData: data,
			hiddenPaneNodes,
			dynamicLogs: state.dynamicLogging?.dynamicLogs
		};
	}, shallowEqual);

	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [unexpectedError, setUnexpectedError] = useState(false);
	const messagesEndRef = useRef(null);

	useEffect(() => {
		// TODO
		const El = document.getElementById("xyz")!;
		if (El) {
			El.scrollTo({ top: El.scrollHeight, behavior: "smooth" });
		}
	}, [derivedState.dynamicLogs?.results]);

	const onSubmit = async (event: React.SyntheticEvent) => {
		setUnexpectedError(false);
		event.preventDefault();

		setLoading(true);
		try {
			dispatch(runNRQL(query));
		} catch (error) {
			setUnexpectedError(true);
		}
		// @ts-ignore
		setLoading(false);
	};

	const { hiddenPaneNodes } = derivedState;
	return (
		<Root id="xyz" ref={messagesEndRef}>
			<PaneHeader title="Observability" id={WebviewPanels.NewRelic}>
				&nbsp;
			</PaneHeader>
			{props.paneState !== PaneState.Collapsed && (
				<PaneBody>
					<div style={{ padding: "0 10px 0 20px" }}></div>
					{derivedState.newRelicIsConnected ? (
						<>
							<PaneNode>
								<PaneNodeName
									title="Welcome to New Relic"
									id="newrelic-welcome"
									count={0}
								></PaneNodeName>
								{!hiddenPaneNodes["newrelic-welcome"] && (
									<>
										<div style={{ padding: "0 20px 0 40px" }}>
											Click Open in IDE from New Relic One to start debugging issues.
										</div>
									</>
								)}
								<PaneNodeName
									title={`Pixie Dynamic Logging${
										derivedState.dynamicLogs?.status ? ` (${derivedState.dynamicLogs.status})` : ""
									}`}
									id="newrelic-pixie"
									count={0}
								></PaneNodeName>
								{!hiddenPaneNodes["newrelic-pixie"] && (
									<>
										<div style={{ padding: "0 20px 0 40px" }}>
											{derivedState.dynamicLogs && (
												<div>
													<table style={{ borderCollapse: "collapse" }}>
														{derivedState.dynamicLogs &&
															derivedState.dynamicLogs.results?.map((_, index) => {
																return (
																	<>
																		{index === 0 && (
																			<tr
																				style={{
																					borderTop: "1px solid #666",
																					borderBottom: "2px solid #666"
																				}}
																			>
																				{Object.keys(_).map(k => {
																					return (
																						<td
																							style={{
																								width: "25%",
																								padding: "5px 0px 5px 0px",
																								fontWeight: "bold"
																							}}
																						>
																							{k}
																						</td>
																					);
																				})}
																			</tr>
																		)}
																		<tr style={{ borderBottom: "1px solid #666" }}>
																			{Object.keys(_).map(k => {
																				return (
																					<td style={{ width: "25%", padding: "3px 0px 3px 0px" }}>
																						{_[k]}
																					</td>
																				);
																			})}
																		</tr>
																	</>
																);
															})}
													</table>
												</div>
											)}
										</div>
									</>
								)}
							</PaneNode>
							{/* <PaneNode>
								<PaneNodeName title="My Errors" id="newrelic-my-errors" count={0}></PaneNodeName>
								{!hiddenPaneNodes["newrelic-my-errors"] && (
									<>
										<ErrorRow title="Exception in thread `main`" />
										<ErrorRow title="hash table index out of range" />
										<ErrorRow title="NoMethodError in TasksControl#show" />
									</>
								)}
							</PaneNode> */}
						</>
					) : (
						<>
							<div className="filters" style={{ padding: "0 20px 10px 20px" }}>
								<span>
									Connect to New Relic to see errors and debug issues.{" "}
									{/* <Tooltip title="Connect later on the Integrations page" placement="top">
										<Linkish
											onClick={() =>
												dispatch(setUserPreference(["skipConnectObservabilityProviders"], true))
											}
										>
											Skip this step.
										</Linkish>
									</Tooltip> */}
								</span>
							</div>

							<IntegrationButtons noBorder style={{ marginBottom: "20px" }}>
								<Provider
									key="newrelic"
									onClick={() =>
										dispatch(configureAndConnectProvider("newrelic*com", "Observability Section"))
									}
								>
									<Icon name="newrelic" />
									Connect to New Relic
								</Provider>
							</IntegrationButtons>
						</>
					)}
				</PaneBody>
			)}
		</Root>
	);
});
