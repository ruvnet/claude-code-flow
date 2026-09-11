<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import IconLayers from "~icons/lucide/layers";
	const publicConfig = usePublicConfig();
	let { close }: { close: () => void } = $props();
</script>

<Modal closeOnBackdrop={false} onclose={close} width="!max-w-[440px] !m-4">
	<div class="welcome-workspace">
		<div class="welcome-symbol"><IconLayers /></div>
		<p class="welcome-label">YOUR AGENT WORKSPACE</p>
		<h1>Welcome to {publicConfig.PUBLIC_APP_NAME || "RuFlo"}.</h1>
		<p>
			Chat with your models, discover MCP tools, and shape a mission with clear acceptance tests.
		</p>
		<p class="welcome-detail">
			The workspace shows observed connections. Runtime actions still require the permissions
			configured by your operator.
		</p>
		<button onclick={close}>Open RuFlo</button>
	</div>
</Modal>

<style>
	.welcome-workspace {
		padding: 2rem;
		color: var(--ws-text);
		background: var(--ws-panel);
	}
	.welcome-symbol {
		width: 48px;
		height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--ws-accent-text);
		border-radius: 0.8rem;
		background: var(--ws-accent-soft);
		margin-bottom: 1.75rem;
	}
	.welcome-label {
		font-size: 0.75rem;
		letter-spacing: 0.12em;
		color: var(--ws-accent-text);
		font-weight: 600;
		margin-bottom: 0.6rem;
	}
	h1 {
		font-size: 1.8rem;
		font-weight: 600;
		letter-spacing: -0.04em;
		line-height: 1.15;
		margin-bottom: 1rem;
	}
	p {
		font-size: 1rem;
		line-height: 1.7;
		color: var(--ws-muted);
	}
	.welcome-detail {
		font-size: 0.875rem;
		margin-top: 1rem;
	}
	button {
		width: 100%;
		min-height: 48px;
		background: var(--ws-accent);
		color: #06261e;
		border-radius: 0.6rem;
		margin-top: 1.5rem;
		font-size: 1rem;
		font-weight: 600;
	}
	:global(:root:not(.dark)) button {
		color: #fff;
	}
</style>
