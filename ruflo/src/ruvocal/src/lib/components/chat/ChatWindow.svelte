<script lang="ts">
	import type { Message, MessageFile } from "$lib/types/Message";
	import { onDestroy } from "svelte";

	import IconOmni from "$lib/components/icons/IconOmni.svelte";
	import IconCheap from "$lib/components/icons/IconCheap.svelte";
	import IconFast from "$lib/components/icons/IconFast.svelte";
	import CarbonCaretDown from "~icons/carbon/caret-down";
	import { PROVIDERS_HUB_ORGS } from "@huggingface/inference";
	import CarbonDirectionRight from "~icons/carbon/direction-right-01";
	import IconArrowUp from "~icons/lucide/arrow-up";
	import IconMic from "~icons/lucide/mic";

	import ChatInput from "./ChatInput.svelte";
	import VoiceRecorder from "./VoiceRecorder.svelte";
	import StopGeneratingBtn from "../StopGeneratingBtn.svelte";
	import type { Model } from "$lib/types/Model";
	import FileDropzone from "./FileDropzone.svelte";
	import RetryBtn from "../RetryBtn.svelte";
	import file2base64 from "$lib/utils/file2base64";
	import { base } from "$app/paths";
	import ChatMessage from "./ChatMessage.svelte";
	import ScrollToBottomBtn from "../ScrollToBottomBtn.svelte";
	import ScrollToPreviousBtn from "../ScrollToPreviousBtn.svelte";
	import { browser } from "$app/environment";
	import { snapScrollToBottom } from "$lib/actions/snapScrollToBottom";
	import SystemPromptModal from "../SystemPromptModal.svelte";
	import ShareConversationModal from "../ShareConversationModal.svelte";
	import ChatIntroduction from "./ChatIntroduction.svelte";
	import UploadedFile from "./UploadedFile.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import { error } from "$lib/stores/errors";
	import ModelSwitch from "./ModelSwitch.svelte";
	import { routerExamples } from "$lib/constants/routerExamples";
	import { mcpExamples } from "$lib/constants/mcpExamples";
	import type { RouterFollowUp, RouterExample } from "$lib/constants/routerExamples";
	import { allBaseServersEnabled, mcpServersLoaded } from "$lib/stores/mcpServers";
	import { shareModal } from "$lib/stores/shareModal";
	import { pendingChatInput } from "$lib/stores/pendingChatInput";
	import LucideHammer from "~icons/lucide/hammer";

	import { fly } from "svelte/transition";
	import { cubicInOut } from "svelte/easing";

	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import { requireAuthUser } from "$lib/utils/auth";
	import { tap, error as hapticError } from "$lib/utils/haptics";
	import { page } from "$app/state";
	import IconZap from "~icons/lucide/zap";
	import {
		isMessageToolCallUpdate,
		isMessageToolErrorUpdate,
		isMessageToolResultUpdate,
	} from "$lib/utils/messageUpdates";
	import type { ToolFront } from "$lib/types/Tool";

	interface Props {
		messages?: Message[];
		messagesAlternatives?: Message["id"][][];
		loading?: boolean;
		pending?: boolean;
		shared?: boolean;
		currentModel: Model;
		models: Model[];
		preprompt?: string | undefined;
		files?: File[];
		onmessage?: (content: string) => void;
		onstop?: () => void;
		onretry?: (payload: { id: Message["id"]; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message["id"] }) => void;
		draft?: string;
	}

	let {
		messages = [],
		messagesAlternatives = [],
		loading = false,
		pending = false,
		shared = false,
		currentModel,
		models,
		preprompt = undefined,
		files = $bindable([]),
		draft = $bindable(""),
		onmessage,
		onstop,
		onretry,
		onshowAlternateMsg,
	}: Props = $props();

	let isReadOnly = $derived(!models.some((model) => model.id === currentModel.id));

	let shareModalOpen = $state(false);
	let editMsdgId: Message["id"] | null = $state(null);
	let pastedLongContent = $state(false);

	// Voice recording state
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let transcriptionEnabled = $derived(
		!!(page.data as { transcriptionEnabled?: boolean }).transcriptionEnabled
	);
	let isTouchDevice = $derived(browser && navigator.maxTouchPoints > 0);

	const handleSubmit = () => {
		if (requireAuthUser() || loading || !draft) return;
		tap();
		onmessage?.(draft);
		draft = "";
	};

	let lastTarget: EventTarget | null = null;

	let onDrag = $state(false);

	const onDragEnter = (e: DragEvent) => {
		lastTarget = e.target;
		onDrag = true;
	};
	const onDragLeave = (e: DragEvent) => {
		if (e.target === lastTarget) {
			onDrag = false;
		}
	};

	const onPaste = (e: ClipboardEvent) => {
		const textContent = e.clipboardData?.getData("text");

		if (!$settings.directPaste && textContent && textContent.length >= 3984) {
			e.preventDefault();
			pastedLongContent = true;
			setTimeout(() => {
				pastedLongContent = false;
			}, 1000);
			const pastedFile = new File([textContent], "Pasted Content", {
				type: "application/vnd.chatui.clipboard",
			});

			files = [...files, pastedFile];
		}

		if (!e.clipboardData) {
			return;
		}

		// paste of files
		const pastedFiles = Array.from(e.clipboardData.files);
		if (pastedFiles.length !== 0) {
			e.preventDefault();

			// filter based on activeMimeTypes, including wildcards
			const filteredFiles = pastedFiles.filter((file) => {
				return activeMimeTypes.some((mimeType: string) => {
					const [type, subtype] = mimeType.split("/");
					const [fileType, fileSubtype] = file.type.split("/");
					return (
						(type === "*" || fileType === type) && (subtype === "*" || fileSubtype === subtype)
					);
				});
			});

			files = [...files, ...filteredFiles];
		}
	};

	let lastMessage = $derived(browser && (messages.at(-1) as Message));
	// Scroll signal includes tool updates and thinking blocks to trigger scroll on all content changes
	let scrollSignal = $derived.by(() => {
		const last = messages.at(-1) as Message | undefined;
		if (!last) return `${messages.length}:0`;

		// Count tool updates to trigger scroll when new tools are called or complete
		const toolUpdateCount = last.updates?.length ?? 0;

		// Include content length, tool count, and message count in signal
		return `${last.id}:${last.content.length}:${messages.length}:${toolUpdateCount}`;
	});
	let streamingAssistantMessage = $derived(
		(() => {
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				const candidate = messages[i];
				if (candidate.from === "assistant") {
					return candidate;
				}
			}
			return undefined;
		})()
	);
	let streamingRouterMetadata = $derived(streamingAssistantMessage?.routerMetadata ?? null);
	let streamingRouterModelName = $derived(
		streamingRouterMetadata?.model
			? (streamingRouterMetadata.model.split("/").pop() ?? streamingRouterMetadata.model)
			: ""
	);

	let lastIsError = $derived(
		!loading &&
			(streamingAssistantMessage?.updates?.findIndex(
				(u) => u.type === "status" && u.status === "error"
			) ?? -1) !== -1
	);

	// Expose currently running tool call name (if any) from the streaming assistant message
	const availableTools: ToolFront[] = $derived.by(
		() => (page.data as { tools?: ToolFront[] } | undefined)?.tools ?? []
	);
	let streamingToolCallName = $derived.by(() => {
		const updates = streamingAssistantMessage?.updates ?? [];
		if (!updates.length) return null;
		const done = new Set<string>();
		for (const u of updates) {
			if (isMessageToolResultUpdate(u) || isMessageToolErrorUpdate(u)) done.add(u.uuid);
		}
		for (let i = updates.length - 1; i >= 0; i -= 1) {
			const u = updates[i];
			if (isMessageToolCallUpdate(u) && !done.has(u.uuid)) {
				return u.call.name;
			}
		}
		return null;
	});
	// Autopilot step tracking — derived from streaming message updates
	let autopilotStep = $derived.by(() => {
		const updates = streamingAssistantMessage?.updates ?? [];
		for (let i = updates.length - 1; i >= 0; i -= 1) {
			const u = updates[i];
			if (u.type === "autopilotStep") {
				return u as { step: number; maxSteps: number; toolCount: number };
			}
		}
		return null;
	});

	let showRouterDetails = $state(false);
	let routerDetailsTimeout: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (!currentModel.isRouter || !loading) {
			showRouterDetails = false;
			if (routerDetailsTimeout) {
				clearTimeout(routerDetailsTimeout);
				routerDetailsTimeout = undefined;
			}
			return;
		}

		if (routerDetailsTimeout) {
			clearTimeout(routerDetailsTimeout);
		}

		showRouterDetails = false;
		routerDetailsTimeout = setTimeout(() => {
			showRouterDetails = true;
		}, 500);
	});

	let sources = $derived(
		files?.map<Promise<MessageFile>>((file) =>
			file2base64(file).then((value) => ({
				type: "base64",
				value,
				mime: file.type,
				name: file.name,
			}))
		)
	);

	const unsubscribeShareModal = shareModal.subscribe((value) => {
		shareModalOpen = value;
	});

	onDestroy(() => {
		unsubscribeShareModal();
		shareModal.close();
		if (routerDetailsTimeout) {
			clearTimeout(routerDetailsTimeout);
		}
	});

	let chatContainer: HTMLElement | undefined = $state();

	// Force scroll to bottom when user sends a new message
	// Pattern: user message + empty assistant message are added together
	let prevMessageCount = $state(messages.length);
	let forceReattach = $state(0);
	$effect(() => {
		if (messages.length > prevMessageCount) {
			const last = messages.at(-1);
			const secondLast = messages.at(-2);
			const userJustSentMessage =
				messages.length === prevMessageCount + 2 &&
				secondLast?.from === "user" &&
				last?.from === "assistant" &&
				last?.content === "";

			if (userJustSentMessage) {
				forceReattach++;
			}
		}
		prevMessageCount = messages.length;
	});

	// Combined scroll dependency for the action
	let scrollDependency = $derived({ signal: scrollSignal, forceReattach });

	const settings = useSettingsStore();
	let hideRouterExamples = $derived($settings.hidePromptExamples?.[currentModel.id] ?? false);

	// Respect per‑model multimodal toggle from settings (force enable)
	let modelIsMultimodalOverride = $derived($settings.multimodalOverrides?.[currentModel.id]);
	let modelIsMultimodal = $derived((modelIsMultimodalOverride ?? currentModel.multimodal) === true);

	// Determine tool support for the current model (server-provided capability with user override)
	let modelSupportsTools = $derived(
		($settings.toolsOverrides?.[currentModel.id] ??
			(currentModel as unknown as { supportsTools?: boolean }).supportsTools) === true
	);

	// Get provider override for the current model (HuggingChat only)
	let providerOverride = $derived($settings.providerOverrides?.[currentModel.id]);
	let hasProviderOverride = $derived(
		providerOverride && providerOverride !== "auto" && !currentModel.isRouter
	);

	// Always allow common text-like files; add images only when model is multimodal
	import { TEXT_MIME_ALLOWLIST, IMAGE_MIME_ALLOWLIST_DEFAULT } from "$lib/constants/mime";

	let activeMimeTypes = $derived(
		Array.from(
			new Set([
				...TEXT_MIME_ALLOWLIST,
				...(modelIsMultimodal
					? (currentModel.multimodalAcceptedMimetypes ?? [...IMAGE_MIME_ALLOWLIST_DEFAULT])
					: []),
			])
		)
	);
	let isFileUploadEnabled = $derived(activeMimeTypes.length > 0);
	let focused = $state(false);

	let activeRouterExamplePrompt: string | null = $state(null);
	// Use MCP examples when all base servers are enabled, otherwise use router examples
	let activeExamples: RouterExample[] = $derived(
		$allBaseServersEnabled ? mcpExamples : routerExamples
	);

	// Map a tool name to follow-up suggestions that make sense after that tool ran.
	// Order matters: more-specific patterns first. Each entry returns up to 2 prompts.
	function followUpsForTool(toolName: string): RouterFollowUp[] {
		const n = toolName.toLowerCase();
		if (n.includes("memory_store"))
			return [
				{ title: "Verify the save", prompt: "Use ruflo__memory_retrieve with the same key and namespace to confirm the save." },
				{ title: "List the namespace", prompt: "Use ruflo__memory_list to show every entry in that namespace." },
			];
		if (n.includes("memory_search") || n.includes("memory_retrieve") || n.includes("memory_list"))
			return [
				{ title: "Save a related item", prompt: "Use ruflo__memory_store to add a related entry to the same namespace." },
				{ title: "Semantic search", prompt: "Run ruvector__hooks_recall on the same query for a semantic match." },
			];
		if (n.includes("system_status") || n.includes("system_health"))
			return [
				{ title: "Performance metrics", prompt: "Run ruflo__performance_metrics and ruflo__performance_bottleneck in parallel." },
				{ title: "Memory usage", prompt: "Run ruflo__memory_stats and ruflo__system_metrics in parallel." },
			];
		if (n.includes("performance_metrics") || n.includes("performance_bottleneck"))
			return [
				{ title: "Optimize", prompt: "Use ruflo__performance_optimize on the slowest component identified." },
				{ title: "Run benchmarks", prompt: "Run ruflo__performance_benchmark with --suite=all." },
			];
		if (n.includes("agent_spawn") || n.includes("swarm_init"))
			return [
				{ title: "Track progress", prompt: "Use ruflo__progress_summary to show what each agent is doing right now." },
				{ title: "Add a tester", prompt: "Spawn a tester agent for the same swarm and have it write integration tests." },
			];
		if (n.includes("hooks_route") || n.includes("hooks_swarm_recommend"))
			return [
				{ title: "Spawn the agent", prompt: "Use ruflo__agent_spawn to create the recommended agent type now." },
				{ title: "Track this run", prompt: "Begin a trajectory with ruvector__hooks_trajectory_begin so the system learns from this work." },
			];
		if (n.includes("analyze_diff") || n.includes("analyze_file"))
			return [
				{ title: "Suggest reviewers", prompt: "Use ruflo__analyze_diff-reviewers to recommend reviewers for the same diff." },
				{ title: "Risk per file", prompt: "Use ruflo__analyze_file-risk on the highest-risk files." },
			];
		if (n.includes("github_repo_analyze") || n.includes("github_pr_manage") || n.includes("github_issue_track"))
			return [
				{ title: "Repo metrics", prompt: "Run ruflo__github_metrics on the same repo and summarize health signals." },
				{ title: "Recent issues", prompt: "List the most recently updated issues with ruflo__github_issue_track." },
			];
		if (n.includes("hooks_trajectory_begin") || n.includes("hooks_trajectory_step"))
			return [
				{ title: "Record next step", prompt: "Record this step with ruvector__hooks_trajectory_step." },
				{ title: "End trajectory", prompt: "Close the trajectory with ruvector__hooks_trajectory_end so the system learns from it." },
			];
		if (n.includes("hooks_security_scan") || n.includes("aidefence"))
			return [
				{ title: "Detail the highest risk", prompt: "Explain the highest-severity finding and propose a concrete fix." },
				{ title: "Re-scan", prompt: "Re-run ruvector__hooks_security_scan after applying the fix." },
			];
		if (n === "search" || n.includes("__search"))
			return [
				{ title: "Deep research", prompt: "Run web_research with action='research' on the same topic for a thorough report." },
				{ title: "Compare alternatives", prompt: "Run web_research with action='compare' to compare the top results." },
			];
		if (n === "web_research" || n.includes("__web_research"))
			return [
				{ title: "Fact-check it", prompt: "Run web_research with action='fact_check' to verify the key claims." },
				{ title: "Save findings", prompt: "Use ruflo__memory_store to save the research summary into a 'research' namespace." },
			];
		if (n.includes("guidance"))
			return [
				{ title: "List my tools", prompt: "Call guidance with topic='overview' to summarize every available tool group." },
				{ title: "Pick one to try", prompt: "Suggest one underused tool from those groups and walk me through calling it." },
			];
		// Default: no specialized follow-up known for this tool.
		return [];
	}

	function dedupePrompts(items: RouterFollowUp[], max: number = 4): RouterFollowUp[] {
		const seen = new Set<string>();
		const out: RouterFollowUp[] = [];
		for (const it of items) {
			const key = it.prompt.trim().toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(it);
			if (out.length >= max) break;
		}
		return out;
	}

	// Pull tool names from the latest assistant message.
	let lastAssistantToolNames: string[] = $derived((() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.from !== "assistant") continue;
			const updates = (msg.updates ?? []) as Array<{ type?: string; subtype?: string; call?: { name?: string } }>;
			const names: string[] = [];
			for (const u of updates) {
				if (u.type === "tool" && u.subtype === "call" && u.call?.name) {
					names.push(u.call.name);
				}
			}
			return names;
		}
		return [];
	})());

	let dynamicFollowUps: RouterFollowUp[] = $derived(
		dedupePrompts(lastAssistantToolNames.flatMap(followUpsForTool), 4)
	);

	let routerFollowUps: RouterFollowUp[] = $derived(
		activeRouterExamplePrompt
			? (activeExamples.find((ex) => ex.prompt === activeRouterExamplePrompt)?.followUps ?? [])
			: []
	);

	// Combined: prefer static example follow-ups (curated by us); fall back to
	// dynamic tool-derived follow-ups generated from the last assistant turn.
	let effectiveFollowUps: RouterFollowUp[] = $derived(
		routerFollowUps.length > 0 ? routerFollowUps : dynamicFollowUps
	);

	let routerUserMessages = $derived(messages.filter((msg) => msg.from === "user"));
	let shouldShowRouterFollowUps = $derived(
		!draft.length &&
			effectiveFollowUps.length > 0 &&
			// Static followups: only after the very first user message (matches an example)
			// Dynamic followups: any time we have at least one assistant turn that finished
			(routerFollowUps.length > 0
				? routerUserMessages.length === 1
				: messages.length > 0 && messages[messages.length - 1]?.from === "assistant") &&
			(currentModel.isRouter || (modelSupportsTools && $allBaseServersEnabled)) &&
			!hideRouterExamples &&
			!loading
	);

	$effect(() => {
		if (
			!(currentModel.isRouter || (modelSupportsTools && $allBaseServersEnabled)) ||
			!messages.length
		) {
			activeRouterExamplePrompt = null;
			return;
		}

		const firstUserMessage = messages.find((msg) => msg.from === "user");
		if (!firstUserMessage) {
			activeRouterExamplePrompt = null;
			return;
		}

		const match = activeExamples.find((ex) => ex.prompt.trim() === firstUserMessage.content.trim());
		activeRouterExamplePrompt = match ? match.prompt : null;
	});

	$effect(() => {
		if ($pendingChatInput) {
			draft = $pendingChatInput;
			pendingChatInput.set(undefined);
		}
	});

	function triggerPrompt(prompt: string) {
		if (requireAuthUser() || loading) return;
		draft = prompt;
		handleSubmit();
	}

	async function startExample(example: RouterExample) {
		if (requireAuthUser()) return;
		activeRouterExamplePrompt = example.prompt;

		if (browser && example.attachments?.length) {
			const loadedFiles: File[] = [];
			for (const attachment of example.attachments) {
				try {
					const response = await fetch(`${base}/${attachment.src}`);
					if (!response.ok) continue;

					const blob = await response.blob();
					const name = attachment.src.split("/").pop() ?? "attachment";
					loadedFiles.push(
						new File([blob], name, { type: blob.type || "application/octet-stream" })
					);
				} catch (err) {
					console.error("Error loading attachment:", err);
				}
			}
			files = loadedFiles;
		}

		triggerPrompt(example.prompt);
	}

	function startFollowUp(followUp: RouterFollowUp) {
		triggerPrompt(followUp.prompt);
	}

	async function handleRecordingConfirm(audioBlob: Blob) {
		isRecording = false;
		isTranscribing = true;

		try {
			const response = await fetch(`${base}/api/transcribe`, {
				method: "POST",
				headers: { "Content-Type": audioBlob.type },
				body: audioBlob,
			});

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const { text } = await response.json();
			const trimmedText = text?.trim();
			if (trimmedText) {
				// Append transcribed text to draft
				draft = draft.trim() ? `${draft.trim()} ${trimmedText}` : trimmedText;
			}
		} catch (err) {
			console.error("Transcription error:", err);
			$error = "Transcription failed. Please try again.";
		} finally {
			isTranscribing = false;
		}
	}

	async function handleRecordingSend(audioBlob: Blob) {
		isRecording = false;
		isTranscribing = true;

		try {
			const response = await fetch(`${base}/api/transcribe`, {
				method: "POST",
				headers: { "Content-Type": audioBlob.type },
				body: audioBlob,
			});

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const { text } = await response.json();
			const trimmedText = text?.trim();
			if (trimmedText) {
				// Set draft and send immediately
				draft = draft.trim() ? `${draft.trim()} ${trimmedText}` : trimmedText;
				handleSubmit();
			}
		} catch (err) {
			console.error("Transcription error:", err);
			$error = "Transcription failed. Please try again.";
		} finally {
			isTranscribing = false;
		}
	}

	function handleRecordingError(message: string) {
		console.error("Recording error:", message);
		isRecording = false;
		$error = message;
	}
</script>

<svelte:window
	ondragenter={onDragEnter}
	ondragleave={onDragLeave}
	ondragover={(e) => {
		e.preventDefault();
	}}
	ondrop={(e) => {
		e.preventDefault();
		onDrag = false;
	}}
/>

<div class="relative z-[-1] min-h-0 min-w-0">
	{#if shareModalOpen}
		<ShareConversationModal open={shareModalOpen} onclose={() => shareModal.close()} />
	{/if}
	<div
		class="scrollbar-custom h-full overflow-y-auto"
		use:snapScrollToBottom={scrollDependency}
		bind:this={chatContainer}
	>
		<div
			class="mx-auto flex h-full max-w-3xl flex-col gap-6 px-5 pt-6 sm:gap-8 xl:max-w-4xl xl:pt-10"
		>
			{#if preprompt && preprompt != currentModel.preprompt}
				<SystemPromptModal preprompt={preprompt ?? ""} />
			{/if}

			{#if messages.length > 0}
				<div class="flex h-max flex-col gap-8 pb-52">
					{#each messages as message, idx (message.id)}
						<ChatMessage
							{loading}
							{message}
							alternatives={messagesAlternatives.find((a) => a.includes(message.id)) ?? []}
							isAuthor={!shared}
							readOnly={isReadOnly}
							isLast={idx === messages.length - 1}
							bind:editMsdgId
							onretry={(payload) => onretry?.(payload)}
							onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
						/>
					{/each}
					{#if isReadOnly}
						<ModelSwitch {models} {currentModel} />
					{/if}
				</div>
			{:else if pending}
				<ChatMessage
					loading={true}
					message={{
						id: "0-0-0-0-0",
						content: "",
						from: "assistant",
						children: [],
					}}
					isAuthor={!shared}
					readOnly={isReadOnly}
				/>
			{:else}
				<ChatIntroduction
					{currentModel}
					onmessage={(content) => {
						draft = content;
					}}
				/>
			{/if}
		</div>

		<ScrollToPreviousBtn class="fixed bottom-48 right-4 lg:right-10" scrollNode={chatContainer} />

		<ScrollToBottomBtn class="fixed bottom-36 right-4 lg:right-10" scrollNode={chatContainer} />
	</div>

	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 z-0 mx-auto flex w-full
			max-w-3xl flex-col items-center justify-center bg-gradient-to-t from-white
			via-white/100 to-white/0 px-3.5 pt-2 dark:border-gray-800
			dark:from-gray-900 dark:via-gray-900/100
			dark:to-gray-900/0 max-sm:py-0 sm:px-5 md:pb-4 xl:max-w-4xl [&>*]:pointer-events-auto"
	>
		{#if !draft.length && !messages.length && !sources.length && !loading && (currentModel.isRouter || (modelSupportsTools && $allBaseServersEnabled)) && activeExamples.length && !hideRouterExamples && !lastIsError && $mcpServersLoaded}
			<div
				class="no-scrollbar mb-3 flex w-full select-none justify-start gap-2 overflow-x-auto whitespace-nowrap text-gray-400 dark:text-gray-500"
			>
				{#each activeExamples as ex}
					<button
						class="flex items-center rounded-lg bg-gray-100/90 px-2 py-0.5 text-center text-sm backdrop-blur hover:text-gray-500 dark:bg-gray-700/50 dark:hover:text-gray-400"
						onclick={() => startExample(ex)}>{ex.title}</button
					>
				{/each}
			</div>
		{/if}
		{#if shouldShowRouterFollowUps && !lastIsError}
			<div
				class="no-scrollbar mb-3 flex w-full select-none justify-start gap-2 overflow-x-auto whitespace-nowrap text-gray-400 dark:text-gray-500"
			>
				<!-- <span class=" text-gray-500 dark:text-gray-400">Follow ups</span> -->
				{#each effectiveFollowUps as followUp}
					<button
						class="flex items-center gap-1 rounded-lg bg-gray-100/90 px-2 py-0.5 text-center text-sm backdrop-blur hover:text-gray-500 dark:bg-gray-700/50 dark:hover:text-gray-400"
						onclick={() => startFollowUp(followUp)}
					>
						<CarbonDirectionRight class="scale-y-[-1] text-xs" />
						{followUp.title}</button
					>
				{/each}
			</div>
		{/if}
		{#if sources?.length && !loading}
			<div
				in:fly|local={sources.length === 1 ? { y: -20, easing: cubicInOut } : undefined}
				class="flex flex-row flex-wrap justify-center gap-2.5 rounded-xl pb-3"
			>
				{#each sources as source, index}
					{#await source then src}
						<UploadedFile
							file={src}
							onclose={() => {
								files = files.filter((_, i) => i !== index);
							}}
						/>
					{/await}
				{/each}
			</div>
		{/if}

		<div class="w-full">
			<div class="flex w-full *:mb-3">
				{#if !loading && lastIsError}
					<RetryBtn
						classNames="ml-auto"
						onClick={() => {
							if (lastMessage && lastMessage.ancestors) {
								onretry?.({
									id: lastMessage.id,
								});
							}
						}}
					/>
				{/if}
			</div>
			<form
				tabindex="-1"
				aria-label={isFileUploadEnabled ? "file dropzone" : undefined}
				onsubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
				class={{
					"relative flex w-full max-w-4xl flex-1 items-center rounded-xl border bg-gray-100 dark:border-gray-700 dark:bg-gray-800": true,
					"opacity-30": isReadOnly,
					"max-sm:mb-4": focused && isVirtualKeyboard(),
				}}
			>
				{#if isRecording || isTranscribing}
					<VoiceRecorder
						{isTranscribing}
						{isTouchDevice}
						oncancel={() => {
							isRecording = false;
						}}
						onconfirm={handleRecordingConfirm}
						onsend={handleRecordingSend}
						onerror={handleRecordingError}
					/>
				{:else if onDrag && isFileUploadEnabled}
					<FileDropzone bind:files bind:onDrag mimeTypes={activeMimeTypes} />
				{:else}
					<div
						class="flex w-full flex-1 rounded-xl border-none bg-transparent"
						class:paste-glow={pastedLongContent}
					>
						{#if lastIsError}
							<ChatInput value="Sorry, something went wrong. Please try again." disabled={true} />
						{:else}
							<ChatInput
								placeholder={isReadOnly ? "This conversation is read-only." : "Ask anything"}
								{loading}
								bind:value={draft}
								bind:files
								mimeTypes={activeMimeTypes}
								onsubmit={handleSubmit}
								{onPaste}
								disabled={isReadOnly || lastIsError}
								{modelIsMultimodal}
								{modelSupportsTools}
								bind:focused
							/>
						{/if}

						{#if loading}
							<StopGeneratingBtn
								onClick={() => {
									hapticError();
									onstop?.();
								}}
								showBorder={true}
								classNames="absolute bottom-2 right-2 size-8 sm:size-7 self-end rounded-full border bg-white text-black shadow transition-none dark:border-transparent dark:bg-gray-600 dark:text-white"
							/>
						{:else}
							<!-- Autopilot toggle -->
							{#if modelSupportsTools}
								<button
									type="button"
									class="btn absolute bottom-2 flex items-center gap-1 self-end rounded-full border px-2.5 py-1 text-xs font-semibold transition-all {transcriptionEnabled ? 'right-[4.75rem] sm:right-[4.25rem]' : 'right-10 sm:right-9'} {$settings.autopilotEnabled
										? 'animate-pulse-subtle border-emerald-400 bg-emerald-500/90 text-white shadow-lg shadow-emerald-500/30 hover:bg-emerald-500 dark:border-emerald-400 dark:bg-emerald-500/80 dark:shadow-emerald-500/40'
										: 'border-gray-300 bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600 dark:hover:text-gray-200'}"
									disabled={isReadOnly}
									onclick={() => {
										tap();
										settings.update((s) => ({ ...s, autopilotEnabled: !s.autopilotEnabled }));
									}}
									title={$settings.autopilotEnabled ? 'Autopilot ON — AI auto-continues tool calls without asking' : 'Autopilot OFF — AI stops after each tool call'}
									aria-label="Toggle autopilot mode"
								>
									<IconZap class="size-3.5" />
									<span>{$settings.autopilotEnabled ? 'AUTO' : 'MANUAL'}</span>
								</button>
							{/if}
							{#if transcriptionEnabled}
								<button
									type="button"
									class="btn absolute bottom-2 right-10 mr-1.5 size-8 self-end rounded-full border bg-white/50 text-gray-500 transition-none hover:bg-gray-50 hover:text-gray-700 dark:border-transparent dark:bg-gray-600/50 dark:text-gray-300 dark:hover:bg-gray-500 dark:hover:text-white sm:right-9 sm:size-7"
									disabled={isReadOnly}
									onclick={() => {
										isRecording = true;
									}}
									aria-label="Start voice recording"
								>
									<IconMic class="size-4" />
								</button>
							{/if}
							<button
								class="btn absolute bottom-2 right-2 size-8 self-end rounded-full border bg-white text-black shadow transition-none enabled:hover:bg-white enabled:hover:shadow-inner dark:border-transparent dark:bg-gray-600 dark:text-white dark:hover:enabled:bg-black sm:size-7 {!draft ||
								isReadOnly
									? ''
									: '!bg-black !text-white dark:!bg-white dark:!text-black'}"
								disabled={!draft || isReadOnly}
								type="submit"
								aria-label="Send message"
								name="submit"
							>
								<IconArrowUp />
							</button>
						{/if}
					</div>
				{/if}
			</form>
			<div
				class={{
					"mt-1.5 flex h-5 items-center self-stretch whitespace-nowrap px-0.5 text-xs text-gray-400/90 max-md:mb-2 max-sm:gap-2": true,
					"max-sm:hidden": focused && isVirtualKeyboard(),
				}}
			>
				{#if models.find((m) => m.id === currentModel.id)}
					{#if loading && autopilotStep}
						<span class="inline-flex items-center gap-1 whitespace-nowrap text-xs text-indigo-400">
							<IconZap class="size-3" />
							Autopilot Step {autopilotStep.step}/{autopilotStep.maxSteps}
							{#if streamingToolCallName}
								<span class="text-gray-400">·</span>
								<LucideHammer class="size-3 text-gray-400" />
								<span class="loading-dots font-medium text-gray-400">
									{availableTools.find((t) => t.name === streamingToolCallName)?.displayName ??
										streamingToolCallName}
								</span>
							{/if}
						</span>
					{:else if loading && streamingToolCallName}
						<span class="inline-flex items-center gap-1 whitespace-nowrap text-xs">
							<LucideHammer class="size-3" />
							Calling tool
							<span class="loading-dots font-medium">
								{availableTools.find((t) => t.name === streamingToolCallName)?.displayName ??
									streamingToolCallName}
							</span>
						</span>
					{:else if !currentModel.isRouter || !loading}
						<a
							href="{base}/settings/{currentModel.id}"
							onclick={(e) => {
								if (requireAuthUser()) {
									e.preventDefault();
								}
							}}
							class="inline-flex items-center gap-1 hover:underline"
						>
							{#if currentModel.isRouter}
								<IconOmni />
								{currentModel.displayName}
							{:else}
								Model: {currentModel.displayName}
								{#if hasProviderOverride}
									{@const hubOrg =
										PROVIDERS_HUB_ORGS[providerOverride as keyof typeof PROVIDERS_HUB_ORGS]}
									<span
										class="inline-flex shrink-0 items-center rounded p-0.5 {providerOverride ===
										'fastest'
											? 'bg-green-100 text-green-600 dark:bg-green-800/20 dark:text-green-500'
											: providerOverride === 'cheapest'
												? 'bg-blue-100 text-blue-600 dark:bg-blue-800/20 dark:text-blue-500'
												: ''}"
										title="Provider: {providerOverride}"
									>
										{#if providerOverride === "fastest"}
											<IconFast classNames="text-sm" />
										{:else if providerOverride === "cheapest"}
											<IconCheap classNames="text-sm" />
										{:else if hubOrg}
											<img
												src="https://huggingface.co/api/avatars/{hubOrg}"
												alt={providerOverride}
												class="size-3 flex-none rounded-sm"
											/>
										{/if}
									</span>
								{/if}
							{/if}
							<CarbonCaretDown class="-ml-0.5 text-xxs" />
						</a>
					{:else if showRouterDetails && streamingRouterMetadata?.route}
						<div
							class="mr-2 flex items-center gap-1.5 whitespace-nowrap text-[.70rem] text-xs leading-none text-gray-400 dark:text-gray-400"
						>
							<IconOmni classNames="text-xs animate-pulse" />

							<span class="router-badge-text router-shimmer">
								{streamingRouterMetadata.route}
							</span>

							<span class="text-gray-500">with</span>

							<span class="router-badge-text">
								{streamingRouterModelName}
							</span>
						</div>
					{:else}
						<div
							class="loading-dots relative inline-flex items-center text-gray-400 dark:text-gray-400"
							aria-label="Routing…"
						>
							<IconOmni classNames="text-xs animate-pulse mr-1" /> Routing
						</div>
					{/if}
				{:else}
					<span class="inline-flex items-center line-through dark:border-gray-700">
						{currentModel.id}
					</span>
				{/if}
				{#if !messages.length && !loading}
					<span class="max-sm:hidden">Generated content may be inaccurate or false.</span>
				{/if}
			</div>
		</div>
	</div>
</div>

<style lang="postcss">
	.paste-glow {
		animation: glow 1s cubic-bezier(0.4, 0, 0.2, 1) forwards;
		will-change: box-shadow;
	}

	@keyframes glow {
		0% {
			box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.8);
		}
		50% {
			box-shadow: 0 0 20px 4px rgba(59, 130, 246, 0.6);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
		}
	}

	.router-badge-text {
		display: inline-block;
		position: relative;
		color: inherit;
	}

	.router-shimmer {
		display: inline-block;
		background-image: linear-gradient(
			90deg,
			rgba(156, 163, 175, 1) 0%,
			rgba(156, 163, 175, 0.6) 10%,
			rgba(156, 163, 175, 0.6) 50%,
			rgba(156, 163, 175, 0.6) 90%,
			rgba(156, 163, 175, 1) 100%
		);
		background-size: 220% 100%;
		animation: router-shimmer 2.8s linear infinite;
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
		-webkit-text-fill-color: transparent;
	}

	:global(.dark) .router-shimmer {
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.15) 0%,
			rgba(255, 255, 255, 0.7) 50%,
			rgba(255, 255, 255, 0.15) 100%
		);
	}

	@keyframes router-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}

	.loading-dots::after {
		content: "";
		animation: dots-content 0.9s steps(1, end) infinite;
	}
	@keyframes dots-content {
		0% {
			content: "";
		}
		33% {
			content: ".";
		}
		66% {
			content: "..";
		}
		88% {
			content: "...";
		}
	}

	:global(.animate-pulse-subtle) {
		animation: pulse-subtle 2s ease-in-out infinite;
	}
	@keyframes pulse-subtle {
		0%,
		100% {
			box-shadow: 0 0 4px 1px rgba(16, 185, 129, 0.3);
		}
		50% {
			box-shadow: 0 0 12px 3px rgba(16, 185, 129, 0.5);
		}
	}
</style>
