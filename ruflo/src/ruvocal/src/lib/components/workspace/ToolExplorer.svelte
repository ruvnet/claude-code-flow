<script lang="ts">
	import { openWorkspaceDraft } from "$lib/utils/openWorkspaceDraft";
	import { error as chatError } from "$lib/stores/errors";
	import {
		allMcpServers,
		selectedServerIds,
		healthCheckServer,
		toggleServer,
	} from "$lib/stores/mcpServers";
	import { discoveredTools } from "$lib/utils/workspace";
	import MCPServerManager from "$lib/components/mcp/MCPServerManager.svelte";
	import IconSearch from "~icons/lucide/search";
	let query = $state("");
	let family = $state("All");
	let serverId = $state("all");
	let limit = $state(30);
	let managerOpen = $state(false);
	let checking = $state<string | null>(null);
	const tools = $derived(discoveredTools($allMcpServers, $selectedServerIds));
	const families = ["All", "Agents", "Memory", "Learning", "Governance", "Tools"];
	const filtered = $derived(
		tools.filter(
			(tool) =>
				(family === "All" || tool.family === family) &&
				(serverId === "all" || tool.serverId === serverId) &&
				`${tool.name} ${tool.description ?? ""} ${tool.serverName}`
					.toLowerCase()
					.includes(query.trim().toLowerCase())
		)
	);
	$effect(() => {
		void query;
		void family;
		void serverId;
		limit = 30;
	});
	async function check(id: string) {
		if (checking) return;
		const server = $allMcpServers.find((entry) => entry.id === id);
		if (!server) return;
		checking = id;
		try {
			await healthCheckServer(server);
		} finally {
			checking = null;
		}
	}
</script>

<div class="ws-section-heading">
	<div>
		<p class="ws-eyebrow">CAPABILITIES</p>
		<h2>Find the right tool.</h2>
		<p>Search up to 1,024 schemas per server. Check a connection to update its inventory.</p>
	</div>
	<button class="ws-button" onclick={() => (managerOpen = true)}>Manage servers</button>
</div>
<div class="ws-server-grid">
	{#each $allMcpServers as server (server.id)}
		<div class="ws-server">
			<div class="ws-row">
				<strong>{server.name}</strong><span
					class="ws-badge"
					class:ws-good={server.status === "connected"}
					>{server.status === "connected"
						? "Discovered"
						: server.status === "error"
							? "Unavailable"
							: server.status === "connecting"
								? "Checking"
								: "Not checked"}</span
				>
			</div>
			<p>
				{server.type === "wasm"
					? "Browser WASM"
					: server.type === "base"
						? "Deployment connection"
						: "Personal connection"} · {server.status === "connected"
					? `${server.tools?.length ?? 0} discovered tools`
					: "Inventory unavailable"}
			</p>
			<div class="ws-row">
				<button class="ws-link-button" disabled={checking !== null} onclick={() => check(server.id)}
					>{checking === server.id ? "Checking…" : "Check connection"}</button
				><button
					class="ws-toggle"
					aria-pressed={$selectedServerIds.has(server.id)}
					onclick={() => toggleServer(server.id)}
					>{$selectedServerIds.has(server.id) ? "Selected for chat" : "Select for chat"}</button
				>
			</div>
		</div>
	{/each}
</div>
<div class="ws-toolbar">
	<div class="ws-search">
		<IconSearch /><input
			aria-label="Search discovered tools"
			placeholder="Search tools, descriptions, or servers…"
			bind:value={query}
		/>
	</div>
	<select aria-label="Filter by server" bind:value={serverId}
		><option value="all">All servers</option>{#each $allMcpServers as server}<option
				value={server.id}>{server.name}</option
			>{/each}</select
	>
</div>
<div class="ws-filters" aria-label="Tool categories">
	{#each families as item}<button
			class:chosen={family === item}
			aria-pressed={family === item}
			onclick={() => (family = item)}>{item}</button
		>{/each}
</div>
<p class="ws-result-count" aria-live="polite">
	{filtered.length} matching tools · showing {Math.min(limit, filtered.length)}
</p>
<div class="ws-tool-list">
	{#each filtered.slice(0, limit) as tool (tool.id)}
		<details class="ws-tool">
			<summary
				><span class="ws-tool-name"
					><strong>{tool.name}</strong><span>{tool.serverName} · {tool.family}</span></span
				><span class="ws-badge"
					>{tool.connected
						? tool.selected
							? "Selected"
							: "Not selected"
						: "Connection unavailable"}</span
				></summary
			>
			<div class="ws-tool-detail">
				<p>{tool.description || "No description provided by this server."}</p>
				<h3>Input schema</h3>
				<pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre>
				<button
					class="ws-button"
					onclick={() =>
						openWorkspaceDraft(
							`Inspect the discovered tool ${tool.name} from ${tool.serverName}. Explain its inputs and risks and draft a use plan. Do not execute it yet.`
						).catch(() => chatError.set("Could not open the tool request draft."))}
					>Draft a tool request</button
				>
			</div>
		</details>
	{:else}
		<div class="ws-empty">
			<strong
				>{tools.length ? "No tools match your filters." : "No tool schemas discovered yet."}</strong
			>
			<p>
				{tools.length
					? "Try another name or category."
					: "Check an available server above, or configure a connection."}
			</p>
		</div>
	{/each}
</div>
{#if filtered.length > limit}<button class="ws-button ws-load-more" onclick={() => (limit += 30)}
		>Show 30 more</button
	>{/if}
{#if managerOpen}<MCPServerManager onclose={() => (managerOpen = false)} />{/if}
