<script lang="ts">
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { openWorkspaceDraft } from "$lib/utils/openWorkspaceDraft";
	import { allMcpServers, selectedServerIds } from "$lib/stores/mcpServers";
	import {
		missionPresets,
		buildMissionDraft,
		discoveredTools,
		type MissionKind,
	} from "$lib/utils/workspace";
	import ToolExplorer from "$lib/components/workspace/ToolExplorer.svelte";
	import RuntimePanel from "$lib/components/workspace/RuntimePanel.svelte";
	import IconArrow from "~icons/lucide/arrow-up-right";
	import IconCommand from "~icons/lucide/command";
	import IconLayers from "~icons/lucide/layers";
	import IconShield from "~icons/lucide/shield-check";
	import IconFlask from "~icons/lucide/flask-conical";
	let { data } = $props();
	let objective = $state("");
	let kind = $state<MissionKind>("build");
	let iterations = $state(3);
	let formError = $state("");
	let opening = $state(false);
	const icons = { build: IconLayers, review: IconShield, optimize: IconFlask };
	const view = $derived(
		["tools", "runtimes"].includes(page.url.searchParams.get("view") ?? "")
			? page.url.searchParams.get("view")
			: "overview"
	);
	const tools = $derived(discoveredTools($allMcpServers, $selectedServerIds));
	const connected = $derived(
		$allMcpServers.filter((server) => server.status === "connected").length
	);
	async function draftMission(event: SubmitEvent) {
		event.preventDefault();
		formError = "";
		try {
			opening = true;
			const draft = buildMissionDraft(objective, kind, iterations);
			await openWorkspaceDraft(draft);
		} catch (error) {
			formError = error instanceof Error ? error.message : "Could not open the mission draft.";
		} finally {
			opening = false;
		}
	}
</script>

<svelte:head
	><title>Workspace · RuFlo</title><meta
		name="description"
		content="Coordinate missions, discover tools, and inspect governed runtime integrations in RuFlo."
	/></svelte:head
>

<main class="ws-workspace scrollbar-custom" id="workspace-main">
	<header class="ws-topbar">
		<a href={`${base}/workspace`} class="ws-wordmark"
			>ru<span>flo</span><span class="ws-divider">/</span><span class="ws-location">Workspace</span
			></a
		>
		<div class="ws-topbar-actions">
			<button
				class="ws-keyboard"
				aria-label="Open command search"
				onclick={() => window.dispatchEvent(new Event("ruflo:commands"))}><IconCommand /> K</button
			><a class="ws-button ws-small" href={`${base}/`}>New chat <IconArrow /></a>
		</div>
	</header>
	<nav class="ws-tabs" aria-label="Workspace sections">
		{#each [{ id: "overview", label: "Overview" }, { id: "tools", label: "Tool explorer" }, { id: "runtimes", label: "Runtime & learning" }] as tab}<a
				aria-current={view === tab.id ? "page" : undefined}
				class:active={view === tab.id}
				href={`${base}/workspace${tab.id === "overview" ? "" : `?view=${tab.id}`}`}>{tab.label}</a
			>{/each}
	</nav>
	<div class="ws-content">
		{#if view === "tools"}<ToolExplorer />
		{:else if view === "runtimes"}<RuntimePanel />
		{:else}
			<div class="ws-intro">
				<div>
					<p class="ws-eyebrow">YOUR AGENT WORKSPACE</p>
					<h1>Intent into action.</h1>
					<p>Bring a goal. Choose the tools. Keep the evidence.</p>
				</div>
				<a class="ws-text-link" href={`${base}/workspace?view=runtimes`}
					>Inspect runtime <IconArrow /></a
				>
			</div>
			<div class="ws-stats">
				<a href={`${base}/models`}
					><span>Available models</span><strong
						>{data.models.length.toString().padStart(2, "0")}</strong
					><small>Configured in this deployment</small></a
				><a href={`${base}/workspace?view=tools`}
					><span>Discovered tools</span><strong>{tools.length.toString().padStart(2, "0")}</strong
					><small>Observed schemas, not permissions</small></a
				><a href={`${base}/workspace?view=tools`}
					><span>Connections checked</span><strong
						>{connected.toString().padStart(2, "0")}<em> / {$allMcpServers.length}</em></strong
					><small>Successful tool discovery</small></a
				>
			</div>
			<div class="ws-mission-grid">
				<section class="ws-panel ws-mission">
					<div class="ws-row">
						<p class="ws-eyebrow">NEW MISSION</p>
						<span class="ws-badge">Draft before execution</span>
					</div>
					<h2>What are we working on?</h2>
					<form onsubmit={draftMission}>
						<label class="sr-only" for="mission-objective">Mission objective</label><textarea
							id="mission-objective"
							required
							maxlength={4000}
							bind:value={objective}
							placeholder="Describe the outcome, repository, and what success looks like…"
							rows="4"
						></textarea>
						<div class="ws-mission-options">
							<label
								>Workflow<select bind:value={kind}
									>{#each missionPresets as preset}<option value={preset.id}>{preset.title}</option
										>{/each}</select
								></label
							><label
								>Requested iterations<select bind:value={iterations}
									>{#each [1, 2, 3, 4, 5] as count}<option value={count}
											>{count} {count === 1 ? "iteration" : "iterations"}</option
										>{/each}</select
								></label
							>
						</div>
						{#if formError}<p class="ws-form-error" role="alert">{formError}</p>{/if}
						<div class="ws-mission-submit">
							<p>
								Opens an editable chat draft.<br />Runtime limits and approvals remain separate.
							</p>
							<button
								class="ws-button ws-primary"
								type="submit"
								disabled={opening || !objective.trim() || !data.models.length}
								>{opening ? "Opening…" : "Draft mission"}<IconArrow /></button
							>
						</div>
						{#if !data.models.length}<p class="ws-form-error">
								Configure a model before drafting a mission in chat.
							</p>{/if}
					</form>
				</section>
				<aside class="ws-loop">
					<p class="ws-eyebrow">THE IMPLEMENTATION LOOP</p>
					<h2>Progress you can verify.</h2>
					<ol>
						{#each [{ title: "Specify", detail: "Inputs, constraints, acceptance test" }, { title: "Build", detail: "Ruflo coordinates available workers" }, { title: "Evaluate", detail: "MetaHarness compares evidence" }, { title: "Review", detail: "Policy, regression, rollback gates" }] as step, index}<li
							>
								<span class="ws-step">0{index + 1}</span>
								<div>
									<strong>{step.title}</strong>
									<p>{step.detail}</p>
								</div>
							</li>{/each}
					</ol>
					<p class="ws-loop-note">Workflow guidance. No mission is running.</p>
				</aside>
			</div>
			<section class="ws-section">
				<div class="ws-section-title">
					<h2>Start with a clear outcome</h2>
					<span>Choose a starting point</span>
				</div>
				<div class="ws-preset-grid">
					{#each missionPresets as preset}{@const Icon = icons[preset.id]}<button
							class="ws-preset"
							onclick={() => {
								kind = preset.id;
								objective = preset.objective;
								document.getElementById("mission-objective")?.focus();
							}}
							><Icon /><strong>{preset.title}</strong><span>{preset.detail}</span><IconArrow
								class="ws-preset-arrow"
							/></button
						>{/each}
				</div>
			</section>
			<section class="ws-section">
				<div class="ws-section-title">
					<h2>Continue your work</h2>
					<a href={`${base}/`}>New conversation ↗</a>
				</div>
				<div class="ws-recent">
					{#each data.conversations.slice(0, 5) as conversation}<a
							href={`${base}/conversation/${conversation.id}`}
							><span class="ws-conversation-icon"><IconCommand /></span><span
								><strong>{conversation.title || "Untitled conversation"}</strong><small
									>{new Date(conversation.updatedAt).toLocaleDateString(undefined, {
										month: "short",
										day: "numeric",
									})}</small
								></span
							><IconArrow /></a
						>{:else}<div class="ws-empty">
							<strong>Your next mission starts here.</strong>
							<p>Draft a goal above or open a new chat. Conversations will appear here.</p>
						</div>{/each}
				</div>
			</section>
			<footer class="ws-footer">
				<span>RuFlo · Coordination with evidence</span><a
					href="https://goal.ruv.io/"
					target="_blank"
					rel="noopener noreferrer">Open research planner ↗</a
				>
			</footer>
		{/if}
	</div>
</main>
