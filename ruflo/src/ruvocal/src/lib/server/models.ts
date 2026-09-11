import { config } from "$lib/server/config";
import type { ChatTemplateInput } from "$lib/types/Template";
import { z } from "zod";
import endpoints, { endpointSchema, type Endpoint } from "./endpoints/endpoints";

import JSON5 from "json5";
import { logger } from "$lib/server/logger";
import { makeRouterEndpoint } from "$lib/server/router/endpoint";

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

const sanitizeJSONEnv = (val: string, fallback: string) => {
	const raw = (val ?? "").trim();
	const unquoted = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
	return unquoted || fallback;
};

const modelConfig = z.object({
	/** Used as an identifier in DB */
	id: z.string().optional(),
	/** Used to link to the model page, and for inference */
	name: z.string().default(""),
	displayName: z.string().min(1).optional(),
	description: z.string().min(1).optional(),
	logoUrl: z.string().url().optional(),
	websiteUrl: z.string().url().optional(),
	modelUrl: z.string().url().optional(),
	tokenizer: z.never().optional(),
	datasetName: z.string().min(1).optional(),
	datasetUrl: z.string().url().optional(),
	preprompt: z.string().default(""),
	prepromptUrl: z.string().url().optional(),
	chatPromptTemplate: z.never().optional(),
	promptExamples: z
		.array(
			z.object({
				title: z.string().min(1),
				prompt: z.string().min(1),
			})
		)
		.optional(),
	endpoints: z.array(endpointSchema).optional(),
	providers: z.array(z.object({ supports_tools: z.boolean().optional() }).passthrough()).optional(),
	parameters: z
		.object({
			temperature: z.number().min(0).max(2).optional(),
			truncate: z.number().int().positive().optional(),
			max_tokens: z.number().int().positive().optional(),
			stop: z.array(z.string()).optional(),
			top_p: z.number().positive().optional(),
			top_k: z.number().positive().optional(),
			frequency_penalty: z.number().min(-2).max(2).optional(),
			presence_penalty: z.number().min(-2).max(2).optional(),
		})
		.passthrough()
		.optional(),
	multimodal: z.boolean().default(false),
	multimodalAcceptedMimetypes: z.array(z.string()).optional(),
	// Aggregated tool-calling capability across providers (HF router)
	supportsTools: z.boolean().default(false),
	unlisted: z.boolean().default(false),
	embeddingModel: z.never().optional(),
	/** Used to enable/disable system prompt usage */
	systemRoleSupported: z.boolean().default(true),
});

type ModelConfig = z.infer<typeof modelConfig>;

const overrideEntrySchema = modelConfig
	.partial()
	.extend({
		id: z.string().optional(),
		name: z.string().optional(),
	})
	.refine((value) => Boolean((value.id ?? value.name)?.trim()), {
		message: "Model override entry must provide an id or name",
	});

type ModelOverride = z.infer<typeof overrideEntrySchema>;

const openaiBaseUrl = config.OPENAI_BASE_URL
	? config.OPENAI_BASE_URL.replace(/\/$/, "")
	: undefined;
const isHFRouter = openaiBaseUrl === "https://router.huggingface.co/v1";

// Exported for tests — validates parsing/passthrough behavior for both the
// HF-router `providers[].supports_tools` shape and the generic
// OpenAI-compatible `capabilities.tool_calling` shape (#2900).
export const listSchema = z
	.object({
		data: z.array(
			z.object({
				id: z.string(),
				description: z.string().optional(),
				providers: z
					.array(z.object({ supports_tools: z.boolean().optional() }).passthrough())
					.optional(),
				// Generic OpenAI-compatible tool-calling signal (non-HF-router providers,
				// e.g. `{ "id": "...", "capabilities": { "tool_calling": true } }`).
				capabilities: z.object({ tool_calling: z.boolean().optional() }).passthrough().optional(),
				architecture: z
					.object({
						input_modalities: z.array(z.string()).optional(),
					})
					.passthrough()
					.optional(),
			})
		),
	})
	.passthrough();

// Exported for tests — a model supports tools if either an HF-router-style
// provider advertises `supports_tools`, or the model itself advertises a
// generic `capabilities.tool_calling` signal. Fails closed when neither is
// present (#2900).
export const deriveSupportsTools = (m: {
	providers?: Array<{ supports_tools?: boolean } | null | undefined> | null;
	capabilities?: { tool_calling?: boolean } | null;
}): boolean =>
	Boolean(
		(m.providers ?? []).some((p) => p?.supports_tools === true) ||
			m.capabilities?.tool_calling === true
	);

function getChatPromptRender(_m: ModelConfig): (inputs: ChatTemplateInput) => string {
	// Minimal template to support legacy "completions" flow if ever used.
	// We avoid any tokenizer/Jinja usage in this build.
	return ({ messages, preprompt }) => {
		const parts: string[] = [];
		if (preprompt) parts.push(`[SYSTEM]\n${preprompt}`);
		for (const msg of messages) {
			const role = msg.from === "assistant" ? "ASSISTANT" : msg.from.toUpperCase();
			parts.push(`[${role}]\n${msg.content}`);
		}
		parts.push(`[ASSISTANT]`);
		return parts.join("\n\n");
	};
}

const processModel = async (m: ModelConfig) => ({
	...m,
	chatPromptRender: await getChatPromptRender(m),
	id: m.id || m.name,
	displayName: m.displayName || m.name,
	preprompt: m.prepromptUrl ? await fetch(m.prepromptUrl).then((r) => r.text()) : m.preprompt,
	parameters: { ...m.parameters, stop_sequences: m.parameters?.stop },
	unlisted: m.unlisted ?? false,
});

const addEndpoint = (m: Awaited<ReturnType<typeof processModel>>) => ({
	...m,
	getEndpoint: async (): Promise<Endpoint> => {
		if (!m.endpoints || m.endpoints.length === 0) {
			throw new Error("No endpoints configured. This build requires OpenAI-compatible endpoints.");
		}
		// Only support OpenAI-compatible endpoints in this build
		const endpoint = m.endpoints[0];
		if (endpoint.type !== "openai") {
			throw new Error("Only 'openai' endpoint type is supported in this build");
		}
		return await endpoints.openai({ ...endpoint, model: m });
	},
});

type InternalProcessedModel = Awaited<ReturnType<typeof addEndpoint>> & {
	isRouter: boolean;
	hasInferenceAPI: boolean;
};

const inferenceApiIds: string[] = [];

const getModelOverrides = (): ModelOverride[] => {
	const overridesEnv = (Reflect.get(config, "MODELS") as string | undefined) ?? "";

	if (!overridesEnv.trim()) {
		return [];
	}

	try {
		return z.array(overrideEntrySchema).parse(JSON5.parse(sanitizeJSONEnv(overridesEnv, "[]")));
	} catch (error) {
		logger.error(error, "[models] Failed to parse MODELS overrides");
		return [];
	}
};

export type ModelsRefreshSummary = {
	refreshedAt: Date;
	durationMs: number;
	added: string[];
	removed: string[];
	changed: string[];
	total: number;
};

export type ProcessedModel = InternalProcessedModel;

export let models: ProcessedModel[] = [];
export let defaultModel!: ProcessedModel;
export let taskModel!: ProcessedModel;
export let validModelIdSchema: z.ZodType<string> = z.string();
export let lastModelRefresh = new Date(0);
export let lastModelRefreshDurationMs = 0;
export let lastModelRefreshSummary: ModelsRefreshSummary = {
	refreshedAt: new Date(0),
	durationMs: 0,
	added: [],
	removed: [],
	changed: [],
	total: 0,
};

let inflightRefresh: Promise<ModelsRefreshSummary> | null = null;

const createValidModelIdSchema = (modelList: ProcessedModel[]): z.ZodType<string> => {
	if (modelList.length === 0) {
		throw new Error("No models available to build validation schema");
	}
	const ids = new Set(modelList.map((m) => m.id));
	return z.string().refine((value) => ids.has(value), "Invalid model id");
};

const resolveTaskModel = (modelList: ProcessedModel[]) => {
	if (modelList.length === 0) {
		throw new Error("No models available to select task model");
	}

	if (config.TASK_MODEL) {
		const preferred = modelList.find(
			(m) => m.name === config.TASK_MODEL || m.id === config.TASK_MODEL
		);
		if (preferred) {
			return preferred;
		}
	}

	return modelList[0];
};

const signatureForModel = (model: ProcessedModel) =>
	JSON.stringify({
		description: model.description,
		displayName: model.displayName,
		providers: model.providers,
		parameters: model.parameters,
		preprompt: model.preprompt,
		prepromptUrl: model.prepromptUrl,
		endpoints:
			model.endpoints?.map((endpoint) => {
				if (endpoint.type === "openai") {
					const { type, baseURL } = endpoint;
					return { type, baseURL };
				}
				return { type: endpoint.type };
			}) ?? null,
		multimodal: model.multimodal,
		multimodalAcceptedMimetypes: model.multimodalAcceptedMimetypes,
		supportsTools: (model as unknown as { supportsTools?: boolean }).supportsTools ?? false,
		isRouter: model.isRouter,
		hasInferenceAPI: model.hasInferenceAPI,
	});

const applyModelState = (newModels: ProcessedModel[], startedAt: number): ModelsRefreshSummary => {
	if (newModels.length === 0) {
		throw new Error("Failed to load any models from upstream");
	}

	const previousIds = new Set(models.map((m) => m.id));
	const previousSignatures = new Map(models.map((m) => [m.id, signatureForModel(m)]));
	const refreshedAt = new Date();
	const durationMs = Date.now() - startedAt;

	models = newModels;
	defaultModel = models[0];
	taskModel = resolveTaskModel(models);
	validModelIdSchema = createValidModelIdSchema(models);
	lastModelRefresh = refreshedAt;
	lastModelRefreshDurationMs = durationMs;

	const added = newModels.map((m) => m.id).filter((id) => !previousIds.has(id));
	const removed = Array.from(previousIds).filter(
		(id) => !newModels.some((model) => model.id === id)
	);
	const changed = newModels
		.filter((model) => {
			const previousSignature = previousSignatures.get(model.id);
			return previousSignature !== undefined && previousSignature !== signatureForModel(model);
		})
		.map((model) => model.id);

	const summary: ModelsRefreshSummary = {
		refreshedAt,
		durationMs,
		added,
		removed,
		changed,
		total: models.length,
	};

	lastModelRefreshSummary = summary;

	logger.info(
		{
			total: summary.total,
			added: summary.added,
			removed: summary.removed,
			changed: summary.changed,
			durationMs: summary.durationMs,
		},
		"[models] Model cache refreshed"
	);

	return summary;
};

const buildModels = async (): Promise<ProcessedModel[]> => {
	if (!openaiBaseUrl) {
		logger.error(
			"OPENAI_BASE_URL is required. Set it to an OpenAI-compatible base (e.g., https://router.huggingface.co/v1)."
		);
		throw new Error("OPENAI_BASE_URL not set");
	}

	try {
		const baseURL = openaiBaseUrl;
		logger.info({ baseURL }, "[models] Using OpenAI-compatible base URL");

		// Canonical auth token is OPENAI_API_KEY; keep HF_TOKEN as legacy alias
		const authToken = config.OPENAI_API_KEY || config.HF_TOKEN;

		// Use auth token from the start if available to avoid rate limiting issues
		// Some APIs rate-limit unauthenticated requests more aggressively
		const response = await fetch(`${baseURL}/models`, {
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		});
		logger.info({ status: response.status }, "[models] First fetch status");
		if (!response.ok && response.status === 401 && !authToken) {
			// If we get 401 and didn't have a token, there's nothing we can do
			throw new Error(
				`Failed to fetch ${baseURL}/models: ${response.status} ${response.statusText} (no auth token available)`
			);
		}
		if (!response.ok) {
			throw new Error(
				`Failed to fetch ${baseURL}/models: ${response.status} ${response.statusText}`
			);
		}
		const json = await response.json();
		logger.info({ keys: Object.keys(json || {}) }, "[models] Response keys");

		const parsed = listSchema.parse(json);
		logger.info({ count: parsed.data.length }, "[models] Parsed models count");

		let modelsRaw = parsed.data.map((m) => {
			let logoUrl: string | undefined = undefined;
			if (isHFRouter && m.id.includes("/")) {
				const org = m.id.split("/")[0];
				logoUrl = `https://huggingface.co/api/avatars/${encodeURIComponent(org)}`;
			}

			const inputModalities = (m.architecture?.input_modalities ?? []).map((modality) =>
				modality.toLowerCase()
			);
			const supportsImageInput =
				inputModalities.includes("image") || inputModalities.includes("vision");

			// A model supports tools if any provider advertises it (HF router), or the
			// model itself advertises a generic tool-calling capability (#2900).
			const supportsTools = deriveSupportsTools(m);
			return {
				id: m.id,
				name: m.id,
				displayName: m.id,
				description: m.description,
				logoUrl,
				providers: m.providers,
				multimodal: supportsImageInput,
				multimodalAcceptedMimetypes: supportsImageInput ? ["image/*"] : undefined,
				supportsTools,
				endpoints: [
					{
						type: "openai" as const,
						baseURL,
						// apiKey will be taken from OPENAI_API_KEY or HF_TOKEN automatically
					},
				],
			} as ModelConfig;
		}) as ModelConfig[];

		const overrides = getModelOverrides();

		if (overrides.length) {
			const overrideMap = new Map<string, ModelOverride>();
			for (const override of overrides) {
				for (const key of [override.id, override.name]) {
					const trimmed = key?.trim();
					if (trimmed) overrideMap.set(trimmed, override);
				}
			}

			// Filter to only configured models and apply overrides, preserving MODELS order
			const filteredAndOrdered: ModelConfig[] = [];
			for (const override of overrides) {
				const matchKey = override.name?.trim() || override.id?.trim() || "";
				const found = modelsRaw.find((model) => model.id === matchKey || model.name === matchKey);
				if (found) {
					const { id, name, ...rest } = override;
					void id;
					void name;
					filteredAndOrdered.push({ ...found, ...rest });
				}
			}

			// If we matched at least one, use filtered list; otherwise fall back to all models with overrides
			if (filteredAndOrdered.length > 0) {
				modelsRaw = filteredAndOrdered;
			} else {
				modelsRaw = modelsRaw.map((model) => {
					const override = overrideMap.get(model.id ?? "") ?? overrideMap.get(model.name ?? "");
					if (!override) return model;

					const { id, name, ...rest } = override;
					void id;
					void name;

					return {
						...model,
						...rest,
					};
				});
			}
		}

		const builtModels = await Promise.all(
			modelsRaw.map((e) =>
				processModel(e)
					.then(addEndpoint)
					.then(async (m) => ({
						...m,
						hasInferenceAPI: inferenceApiIds.includes(m.id ?? m.name),
						// router decoration added later
						isRouter: false as boolean,
					}))
			)
		);

		const archBase = (config.LLM_ROUTER_ARCH_BASE_URL || "").trim();
		const routerLabel = (config.PUBLIC_LLM_ROUTER_DISPLAY_NAME || "Omni").trim() || "Omni";
		const routerLogo = (config.PUBLIC_LLM_ROUTER_LOGO_URL || "").trim();
		const routerAliasId = (config.PUBLIC_LLM_ROUTER_ALIAS_ID || "omni").trim() || "omni";
		const routerMultimodalEnabled =
			(config.LLM_ROUTER_ENABLE_MULTIMODAL || "").toLowerCase() === "true";
		const routerToolsEnabled = (config.LLM_ROUTER_ENABLE_TOOLS || "").toLowerCase() === "true";

		let decorated = builtModels as ProcessedModel[];

		if (archBase) {
			// Build a minimal model config for the alias
			const aliasRaw = {
				id: routerAliasId,
				name: routerAliasId,
				displayName: routerLabel,
				description: "Automatically routes your messages to the best model for your request.",
				logoUrl: routerLogo || undefined,
				preprompt: "",
				endpoints: [
					{
						type: "openai" as const,
						baseURL: openaiBaseUrl,
					},
				],
				// Keep the alias visible
				unlisted: false,
			} as ModelConfig;

			if (routerMultimodalEnabled) {
				aliasRaw.multimodal = true;
				aliasRaw.multimodalAcceptedMimetypes = ["image/*"];
			}

			if (routerToolsEnabled) {
				aliasRaw.supportsTools = true;
			}

			const aliasBase = await processModel(aliasRaw);
			// Create a self-referential ProcessedModel for the router endpoint
			const aliasModel: ProcessedModel = {
				...aliasBase,
				isRouter: true,
				hasInferenceAPI: false,
				// getEndpoint uses the router wrapper regardless of the endpoints array
				getEndpoint: async (): Promise<Endpoint> => makeRouterEndpoint(aliasModel),
			} as ProcessedModel;

			// Put alias first
			decorated = [aliasModel, ...decorated];
		}

		return decorated;
	} catch (e) {
		logger.error(e, "Failed to load models from OpenAI base URL");
		throw e;
	}
};

const rebuildModels = async (): Promise<ModelsRefreshSummary> => {
	const startedAt = Date.now();
	const newModels = await buildModels();
	return applyModelState(newModels, startedAt);
};

await rebuildModels();

export const refreshModels = async (): Promise<ModelsRefreshSummary> => {
	if (inflightRefresh) {
		return inflightRefresh;
	}

	inflightRefresh = rebuildModels().finally(() => {
		inflightRefresh = null;
	});

	return inflightRefresh;
};

export const validateModel = (_models: BackendModel[]) => {
	// Zod enum function requires 2 parameters
	return z.enum([_models[0].id, ..._models.slice(1).map((m) => m.id)]);
};

// if `TASK_MODEL` is string & name of a model in `MODELS`, then we use `MODELS[TASK_MODEL]`, else we try to parse `TASK_MODEL` as a model config itself

export type BackendModel = Optional<
	typeof defaultModel,
	"preprompt" | "parameters" | "multimodal" | "unlisted" | "hasInferenceAPI"
>;
