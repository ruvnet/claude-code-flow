<script lang="ts">
	import { base } from "$app/paths";
	import { onMount } from "svelte";
	import type { WorkspaceSnapshot } from "$lib/types/Workspace";
	import IconActivity from "~icons/lucide/activity";
	let snapshot: WorkspaceSnapshot | null = $state(null);
	let loading = $state(false);
	let message = $state("");
	let stale = $state(false);
	let controller: AbortController | null = null;
	const catalog = [
		{
			id: "ruflo",
			name: "Ruflo",
			role: "Coordination",
			description: "Runtime and policy status from configured MCP tools.",
			tag: "MCP",
			href: "https://github.com/ruvnet/ruflo",
		},
		{
			id: "metaharness",
			name: "MetaHarness",
			role: "Evaluation",
			description: "Bounded optimization status. Promotion remains a separate authorized action.",
			tag: "MCP",
			href: "https://github.com/ruvnet/metaharness",
		},
		{
			id: "autogenous",
			name: "Autogenous",
			role: "Collaboration",
			description:
				"Signed collaboration and evolution receipts. Requires an operator supplied MCP adapter.",
			tag: "ADAPTER",
			href: "https://github.com/ruvnet/autogenous",
		},
		{
			id: "ruos",
			name: "ruOS",
			role: "Compute",
			description: "Server health through a private, authenticated deployment connection.",
			tag: "HTTP",
			href: "https://github.com/cognitum-one/ruos-desktop",
		},
	];
	const labels = {
		not_configured: "Not configured",
		available: "Available",
		degraded: "Degraded",
		unreachable: "Unreachable",
	};
	async function refresh() {
		if (loading) return;
		controller = new AbortController();
		const deadline = setTimeout(() => controller?.abort(), 8000);
		loading = true;
		message = "";
		try {
			const response = await fetch(`${base}/api/workspace`, {
				signal: controller.signal,
				cache: "no-store",
			});
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					snapshot = null;
					throw new Error(
						"Runtime status requires an administrator session. Chat and your personal tools remain available."
					);
				}
				throw new Error("Runtime status is unavailable. Retry to get a fresh observation.");
			}
			const result: WorkspaceSnapshot = await response.json();
			if (result.schemaVersion !== 1 || !Array.isArray(result.integrations))
				throw new Error("The runtime response has an unsupported format.");
			snapshot = result;
			stale = false;
		} catch (error) {
			stale = snapshot !== null;
			message =
				error instanceof Error && error.name !== "AbortError"
					? error.message
					: "The status request timed out. Retry when the connection is available.";
		} finally {
			clearTimeout(deadline);
			loading = false;
		}
	}
	onMount(() => {
		void refresh();
		return () => controller?.abort();
	});
</script>

<div class="ws-section-heading">
	<div>
		<p class="ws-eyebrow">RUNTIME & LEARNING</p>
		<h2>Every connection has evidence.</h2>
		<p>Refresh on demand. Availability is an observation, not execution authority.</p>
	</div>
	<button class="ws-button" disabled={loading} onclick={refresh}
		><IconActivity />{loading ? "Checking…" : "Refresh status"}</button
	>
</div>
{#if message}<div class="ws-notice" role="status">{message}</div>{/if}
{#if snapshot}<p class="ws-result-count">
		{stale ? "Stale observation" : "Observed"} · {new Date(snapshot.checkedAt).toLocaleString()}
	</p>{/if}
<div class="ws-runtime-grid">
	{#each catalog as entry}
		{@const integration = snapshot?.integrations.find((item) => item.id === entry.id)}
		<article class="ws-runtime">
			<div class="ws-row">
				<span class="ws-eyebrow">{entry.role}</span><span
					class="ws-badge"
					class:ws-good={!stale && integration?.state === "available"}
					>{stale
						? "Stale"
						: integration
							? labels[integration.state]
							: loading
								? "Checking"
								: "Not checked"}</span
				>
			</div>
			<h3>{entry.name}<span>{entry.tag}</span></h3>
			<p>{integration?.summary || entry.description}</p>
			{#if integration && integration.state !== "not_configured"}
				<p class="ws-fine">
					{integration.source.label}{entry.id === "metaharness" &&
					integration.source.configuredBy === "WORKSPACE_RUFLO_MCP_URL"
						? " · via the configured Ruflo endpoint"
						: ""}
				</p>
			{/if}
			{#if integration?.source.discoveryOnly}<p class="ws-fine">
					Tool discovery only. Runtime health has not been verified.
				</p>{/if}
			{#if integration && integration.metrics.length > 0}<dl class="ws-runtime-metrics">
					{#each integration.metrics as metric}<div>
							<dt>{metric.label}</dt>
							<dd>{metric.value}</dd>
						</div>{/each}
				</dl>{/if}
			<div class="ws-runtime-footer">
				<a href={entry.href} target="_blank" rel="noopener noreferrer">Source ↗</a><span
					>{integration?.latencyMs != null
						? `${integration.latencyMs} ms observation`
						: "No observation yet"}</span
				>
			</div>
		</article>
	{/each}
</div>
<section class="ws-panel ws-gates">
	<div>
		<p class="ws-eyebrow">PROMOTION CONTRACT</p>
		<h3>Better. Safe. Authorized. Reversible.</h3>
		<p>
			Autogenous candidates must pass all four gates. MetaHarness evaluation does not grant
			promotion authority. No candidate has been evaluated by this workspace.
		</p>
	</div>
	<div class="ws-gate-list">
		{#each ["Measured improvement", "Safety & regression checks", "Policy authorization", "Verified rollback"] as gate}<div
			>
				<span>{gate}</span><span class="ws-badge">Not evaluated</span>
			</div>{/each}
	</div>
</section>
