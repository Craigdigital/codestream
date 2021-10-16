import React from "react";
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { closeAllPanels, setCurrentCodeError } from "@codestream/webview/store/context/actions";
import { CodeStreamState } from "../../store";
import { getCodeError } from "../../store/codeErrors/reducer";
import { Dispatch } from "../../store/common";
import Dismissable from "../Dismissable";
import { GetReposScmRequestType, ReposScm } from "@codestream/protocols/agent";
import { HostApi } from "../../";
import { CSCodeError } from "@codestream/protocols/api";
import { logWarning } from "../../logger";
import { DropdownButton } from "../DropdownButton";
import { useDidMount } from "@codestream/webview/utilities/hooks";
import styled from "styled-components";

const Ellipsize = styled.div`
	button {
		max-width: calc(100vw - 40px);
	}
`;

interface EnhancedRepoScm {
	/**
	 * name of the repo
	 */
	name: string;
	/**
	 * remote url
	 */
	remote: string;

	/** unique string */
	key: string;
}

export function RepositoryAssociator(props: {
	error: { title: string; description: string };
	onSelected?: Function;
	onSubmit: Function;
	onCancelled: Function;
}) {
	const dispatch = useDispatch<Dispatch | any>();
	const derivedState = useSelector((state: CodeStreamState) => {
		const codeError = state.context.currentCodeErrorId
			? (getCodeError(state.codeErrors, state.context.currentCodeErrorId) as CSCodeError)
			: undefined;

		const result = {
			codeError: codeError,
			repos: state.repos
		};
		// 	// console.warn(JSON.stringify(result, null, 4));
		return result;
	});
	const { error: repositoryError } = props;

	const [openRepositories, setOpenRepositories] = React.useState<
		(ReposScm & EnhancedRepoScm)[] | undefined
	>(undefined);
	const [selected, setSelected] = React.useState<any>(undefined);
	const [multiRemoteRepository, setMultiRemoteRepository] = React.useState(false);

	useDidMount(() => {
		if (!repositoryError) return;

		HostApi.instance
			.send(GetReposScmRequestType, {
				inEditorOnly: true,
				includeRemotes: true
			})
			.then(_ => {
				if (!_.repositories) return;

				const results: (ReposScm & EnhancedRepoScm)[] = [];
				for (const repo of _.repositories) {
					if (repo.remotes && repo.remotes.length > 1) {
						for (const e of repo.remotes) {
							const id = repo.id || "";
							if (!e.types || !id) continue;
							const remoteUrl = e.types?.find(_ => _.type === "fetch")?.url;
							if (!remoteUrl) continue;
							results.push({
								...repo,
								remote: remoteUrl!,
								key: btoa(remoteUrl!),
								name:
									(derivedState.repos[id] ? derivedState.repos[id].name : "") + ` (${remoteUrl})`
							});
						}
						setMultiRemoteRepository(true);
					} else {
						const id = repo.id || "";
						if (!repo.remotes || !repo.remotes[0].types || !id) continue;
						const url = repo.remotes[0].types.find(_ => _.type === "fetch")?.url!;
						results.push({
							...repo,
							key: btoa(url),
							remote: url,
							name: derivedState.repos[id] ? derivedState.repos[id].name : ""
						});
					}
				}

				setOpenRepositories(results);
			})
			.catch(e => {
				logWarning(`could not get repos: ${e.message}`);
			});
	});

	if (openRepositories?.length === 0) {
		return (
			<Dismissable
				title={repositoryError.title}
				buttons={[
					{
						text: "Dismiss",
						onClick: e => {
							e.preventDefault();
							props.onCancelled(e);
						}
					}
				]}
			>
				<p>Could not locate any open repositories. Please open a repository and try again.</p>
			</Dismissable>
		);
	}

	return (
		<Dismissable
			title={repositoryError.title}
			buttons={[
				{
					text: "Associate",
					onClick: e => {
						e.preventDefault();
						props.onSubmit(selected);
					},
					disabled: !selected
				},
				{
					text: "Cancel",
					isSecondary: true,
					onClick: e => {
						e.preventDefault();
						props.onCancelled(e);
					}
				}
			]}
		>
			<p>{repositoryError.description}</p>
			{multiRemoteRepository && (
				<p>If this is a forked repository, please select the upstream remote.</p>
			)}
			<Ellipsize>
				<DropdownButton
					items={
						openRepositories
							?.sort((a, b) => a.name.localeCompare(b.name))
							.map(_ => {
								return {
									key: _.key,
									label: _.name,
									action: () => {
										setSelected(_);
										props.onSelected && props.onSelected(_);
									}
								};
							}) || []
					}
					selectedKey={selected ? selected.id : null}
					variant={selected ? "secondary" : "primary"}
					size="compact"
					wrap
				>
					{selected ? selected.name : "select a repo"}
				</DropdownButton>
			</Ellipsize>
		</Dismissable>
	);
}
