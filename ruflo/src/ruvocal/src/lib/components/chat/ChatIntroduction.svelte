<script lang="ts">
	import { base } from "$app/paths";
	import type { Model } from "$lib/types/Model";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { missionPresets } from "$lib/utils/workspace";
	import IconArrow from "~icons/lucide/arrow-up-right";
	import IconSparkles from "~icons/lucide/sparkles";
	const publicConfig = usePublicConfig();
	interface Props {
		currentModel: Model;
		onmessage?: (content: string) => void;
	}
	let { currentModel, onmessage }: Props = $props();
</script>

<section class="chat-launch">
	<div class="launch-label">
		<span class="launch-mark"><IconSparkles /></span>{publicConfig.PUBLIC_APP_NAME || "RuFlo"}<span
			class="launch-separator">/</span
		>Chat
	</div>
	<h1>What will you build next?</h1>
	<p>Think it through. Bring your tools. Turn a clear goal into a verifiable result.</p>
	<div class="launch-presets">
		{#each missionPresets as preset}
			<button onclick={() => onmessage?.(preset.objective)}
				><strong>{preset.title}</strong><span>{preset.detail}</span><IconArrow /></button
			>
		{/each}
	</div>
	<div class="launch-footer">
		<span>Model: {currentModel.displayName || currentModel.name}</span><a href={`${base}/workspace`}
			>Open workspace <IconArrow /></a
		>
	</div>
</section>

<style>
	.chat-launch {
		margin: auto 0;
		padding: 2rem 0 15rem;
		width: 100%;
		text-align: left;
		color: var(--ws-text);
	}
	.launch-label {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		font-size: 0.875rem;
		color: var(--ws-muted);
		margin-bottom: 1.75rem;
	}
	.launch-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 34px;
		width: 34px;
		background: var(--ws-accent-soft);
		border-radius: 0.6rem;
		color: var(--ws-accent-text);
	}
	.launch-mark :global(svg) {
		width: 18px;
		height: 18px;
	}
	.launch-separator {
		color: var(--ws-border);
	}
	h1 {
		font-size: clamp(1.8rem, 3.2vw, 3rem);
		font-weight: 550;
		letter-spacing: -0.045em;
		line-height: 1.15;
		margin: 0 0 1rem;
	}
	.chat-launch > p {
		color: var(--ws-muted);
		font-size: 1rem;
		line-height: 1.7;
		max-width: 480px;
	}
	.launch-presets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.75rem;
		margin: 1.8rem 0;
	}
	.launch-presets button {
		position: relative;
		display: grid;
		gap: 0.6rem;
		padding: 1.1rem;
		border: 1px solid var(--ws-border);
		background: var(--ws-panel);
		border-radius: 0.75rem;
		text-align: left;
		transition:
			border-color 0.15s,
			transform 0.15s;
	}
	.launch-presets button:hover {
		border-color: var(--ws-accent);
		transform: translateY(-2px);
	}
	.launch-presets button:focus-visible {
		outline: 2px solid var(--ws-accent);
		outline-offset: 3px;
	}
	.launch-presets strong {
		font-size: 0.875rem;
		font-weight: 600;
		padding-right: 0.75rem;
	}
	.launch-presets span {
		font-size: 0.875rem;
		color: var(--ws-muted);
		line-height: 1.5;
	}
	.launch-presets :global(svg) {
		position: absolute;
		top: 0.8rem;
		right: 0.7rem;
		width: 14px;
		height: 14px;
		color: var(--ws-muted);
	}
	.launch-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.875rem;
		color: var(--ws-muted);
	}
	.launch-footer a {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--ws-accent-text);
		white-space: nowrap;
	}
	.launch-footer :global(svg) {
		width: 16px;
	}
	@media (max-width: 640px) {
		.chat-launch {
			padding-top: 0.5rem;
		}
		.launch-label {
			margin-bottom: 1.3rem;
		}
		.launch-presets {
			grid-template-columns: 1fr;
			gap: 0.5rem;
			margin: 1.3rem 0;
		}
		.launch-presets button {
			padding: 0.85rem 1rem;
			gap: 0.3rem;
		}
		.launch-footer {
			flex-wrap: wrap;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.launch-presets button {
			transition: none;
		}
	}
</style>
