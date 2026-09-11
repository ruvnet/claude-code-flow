import { defaultModel } from "$lib/server/models";
import { building } from "$app/environment";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export type StreamingMode = "raw" | "smooth";

export interface Settings extends Timestamps {
	userId?: User["_id"];
	sessionId?: string;

	shareConversationsWithModelAuthors: boolean;
	/** One-time welcome modal acknowledgement */
	welcomeModalSeenAt?: Date | null;
	activeModel: string;

	// model name and system prompts
	customPrompts?: Record<string, string>;

	/**
	 * Per‑model overrides to enable multimodal (image) support
	 * even when not advertised by the provider/model list.
	 * Only the `true` value is meaningful (enables images).
	 */
	multimodalOverrides?: Record<string, boolean>;

	/**
	 * Per‑model overrides to enable tool calling (OpenAI tools/function calling)
	 * even when not advertised by the provider list. Only `true` is meaningful.
	 */
	toolsOverrides?: Record<string, boolean>;

	/**
	 * Per-model toggle to hide Omni prompt suggestions shown near the composer.
	 * When set to `true`, prompt examples for that model are suppressed.
	 */
	hidePromptExamples?: Record<string, boolean>;

	/**
	 * Per-model inference provider preference.
	 * Values: "auto" (default), "fastest", "cheapest", or a specific provider name (e.g., "together", "sambanova").
	 * The value is appended to the model ID when making inference requests (e.g., "model:fastest").
	 */
	providerOverrides?: Record<string, string>;

	/**
	 * Preferred assistant output behavior in the chat UI.
	 * - "raw": show provider-native stream chunks
	 * - "smooth": show smoothed stream chunks
	 */
	streamingMode: StreamingMode;
	directPaste: boolean;

	/**
	 * Whether haptic feedback is enabled on supported touch devices.
	 * Uses the ios-haptics library for cross-platform vibration.
	 */
	hapticsEnabled: boolean;

	/**
	 * Autopilot mode — AI auto-continues after tool calls without user intervention.
	 * When enabled, the model loops through tool calls automatically up to maxSteps.
	 */
	autopilotEnabled: boolean;

	/**
	 * Maximum number of autopilot steps (tool call loops) before stopping.
	 * Default is 10. Range: 1-50.
	 */
	autopilotMaxSteps: number;

	/**
	 * Organization to bill inference requests to (HuggingChat only).
	 * Stores the org's preferred_username. If empty/undefined, bills to personal account.
	 */
	billingOrganization?: string;
}

export type SettingsEditable = Omit<Settings, "welcomeModalSeenAt" | "createdAt" | "updatedAt">;
// TODO: move this to a constant file along with other constants
export const DEFAULT_SETTINGS = {
	shareConversationsWithModelAuthors: true,
	activeModel: building ? "" : defaultModel.id,
	customPrompts: {},
	multimodalOverrides: {},
	toolsOverrides: {},
	hidePromptExamples: {},
	providerOverrides: {},
	streamingMode: "smooth",
	directPaste: false,
	hapticsEnabled: true,
	autopilotEnabled: true,
	autopilotMaxSteps: 10,
} satisfies SettingsEditable;
