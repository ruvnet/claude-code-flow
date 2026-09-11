<script lang="ts">
	import { onMount } from "svelte";
	import type { Component } from "svelte";
	import { error } from "$lib/stores/errors";
	let Palette: Component<{ open?: boolean }> | null = $state(null);
	let open = $state(false);
	let loading = false;
	async function toggle() {
		if (loading || document.getElementById("app")?.hasAttribute("inert")) return;
		if (!Palette) {
			loading = true;
			try {
				Palette = (await import("./CommandPalette.svelte")).default;
			} catch {
				error.set("Command search could not load. Use the workspace navigation.");
				return;
			} finally {
				loading = false;
			}
		}
		open = !open;
	}
	onMount(() => {
		const keyboard = (event: KeyboardEvent) => {
			if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "k" &&
				!event.isComposing
			) {
				if (document.getElementById("app")?.hasAttribute("inert")) return;
				event.preventDefault();
				void toggle();
			}
		};
		const requested = () => {
			void toggle();
		};
		window.addEventListener("keydown", keyboard);
		window.addEventListener("ruflo:commands", requested);
		return () => {
			window.removeEventListener("keydown", keyboard);
			window.removeEventListener("ruflo:commands", requested);
		};
	});
</script>

{#if Palette}<Palette bind:open />{/if}
