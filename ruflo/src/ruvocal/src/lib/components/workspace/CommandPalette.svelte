<script lang="ts">
	import { base } from "$app/paths";
	import { Dialog } from "bits-ui";
	import IconSearch from "~icons/lucide/search";
	let { open = $bindable(false) }: { open?: boolean } = $props();
	let query = $state("");
	const commands = [
		{
			title: "Open workspace",
			detail: "Draft a mission and resume work",
			href: `${base}/workspace`,
		},
		{ title: "New chat", detail: "Chat with a configured model", href: `${base}/` },
		{
			title: "Explore tools",
			detail: "Search discovered MCP capabilities",
			href: `${base}/workspace?view=tools`,
		},
		{
			title: "Runtime & learning",
			detail: "Inspect integrations and evaluation gates",
			href: `${base}/workspace?view=runtimes`,
		},
		{ title: "Choose a model", detail: "Available models and settings", href: `${base}/models` },
		{
			title: "Application settings",
			detail: "Preferences and configuration",
			href: `${base}/settings/application`,
		},
	];
	const filtered = $derived(
		commands.filter((command) =>
			`${command.title} ${command.detail}`.toLowerCase().includes(query.trim().toLowerCase())
		)
	);
	$effect(() => {
		if (open) query = "";
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="command-overlay" />
		<Dialog.Content class="command-dialog">
			<Dialog.Title class="command-title">Go to</Dialog.Title>
			<Dialog.Description class="sr-only"
				>Search workspace destinations. Tab to a result and press Enter to open it.</Dialog.Description
			>
			<div class="command-input">
				<IconSearch /><input
					aria-label="Search commands"
					placeholder="Search commands…"
					bind:value={query}
				/>
			</div>
			<div class="command-results">
				{#each filtered as command}
					<a href={command.href} onclick={() => (open = false)}
						><strong>{command.title}</strong><span>{command.detail}</span></a
					>
				{:else}<p>No matching commands.</p>{/each}
			</div>
			<Dialog.Close class="command-close">Close <kbd>Esc</kbd></Dialog.Close>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.command-overlay) {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: #020617b3;
		backdrop-filter: blur(6px);
	}
	:global(.command-dialog) {
		position: fixed;
		z-index: 71;
		top: 15%;
		left: 50%;
		transform: translateX(-50%);
		width: min(560px, calc(100vw - 2rem));
		max-height: 75dvh;
		overflow-y: auto;
		border: 1px solid var(--ws-border);
		border-radius: 1rem;
		background: var(--ws-panel);
		color: var(--ws-text);
		padding: 1.25rem;
		box-shadow: 0 30px 90px #0005;
	}
	:global(.command-title) {
		font-size: 1.2rem;
		font-weight: 650;
		margin-bottom: 1rem;
	}
	.command-input {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		padding: 0.8rem;
		border: 1px solid var(--ws-border);
		border-radius: 0.6rem;
	}
	.command-input input {
		width: 100%;
		background: transparent;
		font-size: 1rem;
		outline: none;
	}
	.command-results {
		display: grid;
		gap: 0.25rem;
		margin: 0.75rem 0;
	}
	.command-results a {
		display: grid;
		gap: 0.25rem;
		padding: 0.8rem;
		border-radius: 0.6rem;
	}
	.command-results a:hover,
	.command-results a:focus-visible {
		background: var(--ws-accent-soft);
	}
	.command-results strong {
		font-size: 0.95rem;
	}
	.command-results span,
	.command-results p {
		font-size: 0.875rem;
		color: var(--ws-muted);
	}
	:global(.command-close) {
		display: flex;
		width: 100%;
		justify-content: space-between;
		font-size: 0.875rem;
		color: var(--ws-muted);
		padding: 0.5rem;
	}
</style>
