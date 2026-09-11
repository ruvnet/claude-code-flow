<script lang="ts">
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import IconWorkspace from "~icons/lucide/layout-dashboard";
	import IconTools from "~icons/lucide/blocks";
	import IconActivity from "~icons/lucide/activity";
	import IconResearch from "~icons/lucide/telescope";
	const items = [
		{ label: "Workspace", href: `${base}/workspace`, view: "overview", icon: IconWorkspace },
		{
			label: "Tool explorer",
			href: `${base}/workspace?view=tools`,
			view: "tools",
			icon: IconTools,
		},
		{
			label: "Runtime & learning",
			href: `${base}/workspace?view=runtimes`,
			view: "runtimes",
			icon: IconActivity,
		},
	];
</script>

<div class="workspace-nav" aria-label="Workspace navigation">
	{#each items as item}
		{@const selected =
			page.url.pathname === `${base}/workspace` &&
			(page.url.searchParams.get("view") || "overview") === item.view}
		<a href={item.href} aria-current={selected ? "page" : undefined} class:current={selected}>
			<item.icon /> <span>{item.label}</span>
		</a>
	{/each}
	<a href="https://goal.ruv.io/" target="_blank" rel="noopener noreferrer"
		><IconResearch /><span>Research planner</span><span
			class="external"
			aria-label="opens in a new tab">↗</span
		></a
	>
</div>

<style>
	.workspace-nav {
		display: grid;
		gap: 0.25rem;
		padding-bottom: 1rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid var(--ws-border);
	}
	a {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 44px;
		border-radius: 0.65rem;
		padding: 0.65rem 0.75rem;
		font-size: 0.875rem;
		color: var(--ws-muted);
		transition: background 0.15s;
	}
	a:hover {
		background: var(--ws-hover);
		color: var(--ws-text);
	}
	a.current {
		color: var(--ws-accent-text);
		background: var(--ws-accent-soft);
		font-weight: 600;
	}
	a :global(svg) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
	}
	.external {
		margin-left: auto;
	}
</style>
