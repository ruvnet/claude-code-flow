import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { RequestHandler } from "./$types";
import { resolveHealthTarget, HealthTargetError } from "$lib/server/mcp/resolveHealthTarget";
import { isStrictHfMcpLogin, hasNonEmptyToken, isExaMcpServer } from "$lib/server/mcp/hf";

interface HealthCheckResponse {
	ready: boolean;
	tools?: Array<{
		name: string;
		description?: string;
		inputSchema?: unknown;
	}>;
	error?: string;
	authRequired?: boolean;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	let client: Client | undefined;
	let configuredRequest = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;

	try {
		const target = resolveHealthTarget(await request.json(), config.MCP_SERVERS || "[]");
		const { url, headers } = target;
		configuredRequest = target.configured;

		// Inject Exa API key for mcp.exa.ai servers via URL param
		let finalUrl = url;
		try {
			const exaApiKey = config.EXA_API_KEY;
			if (isExaMcpServer(url) && hasNonEmptyToken(exaApiKey)) {
				const urlObj = new URL(url);
				if (!urlObj.searchParams.has("exaApiKey")) {
					urlObj.searchParams.set("exaApiKey", exaApiKey);
					finalUrl = urlObj.toString();
					logger.debug({}, "[MCP Health] injected Exa API key");
				}
			}
		} catch {
			// best-effort injection
		}

		const baseUrl = new URL(finalUrl);

		// Minimal header handling
		const headersRecord: Record<string, string> = headers?.length
			? Object.fromEntries(headers.map((h) => [h.key, h.value]))
			: {};
		if (!headersRecord["Accept"]) {
			headersRecord["Accept"] = "application/json, text/event-stream";
		}

		// If enabled, attach the logged-in user's HF token only for the official HF MCP endpoint
		try {
			const shouldForward = config.MCP_FORWARD_HF_USER_TOKEN === "true";
			const userToken =
				(locals as unknown as { hfAccessToken?: string } | undefined)?.hfAccessToken ??
				(locals as unknown as { token?: string } | undefined)?.token;
			const hasAuth = typeof headersRecord["Authorization"] === "string";
			const isHfMcpTarget = isStrictHfMcpLogin(url);
			if (shouldForward && !hasAuth && isHfMcpTarget && hasNonEmptyToken(userToken)) {
				headersRecord["Authorization"] = `Bearer ${userToken}`;
			}
		} catch {
			// best-effort overlay
		}

		// Add an abort timeout to outbound requests (align with fetch-url: 30s)
		controller = new AbortController();
		timeoutId = setTimeout(() => controller?.abort(), 30000);
		const signal = controller.signal;
		const requestInit: RequestInit = {
			headers: headersRecord,
			signal,
			...(configuredRequest ? { redirect: "error" as const } : {}),
		};
		// SSE's EventSource GET does not inherit requestInit.redirect. Pin every
		// configured transport request to its deployment origin and forbid redirects.
		const configuredFetch: typeof fetch | undefined = configuredRequest
			? async (input, init) => {
					const destination = new URL(input instanceof Request ? input.url : input);
					if (destination.origin !== baseUrl.origin)
						throw new Error("Configured MCP health target cannot change origin");
					return fetch(input, { ...init, redirect: "error", signal });
				}
			: undefined;

		let httpError: Error | undefined;
		let lastError: Error | undefined;

		// Try Streamable HTTP transport first
		try {
			logger.info({}, "[MCP Health] Trying HTTP transport");
			client = new Client({
				name: "chat-ui-health-check",
				version: "1.0.0",
			});

			const transport = new StreamableHTTPClientTransport(baseUrl, {
				requestInit,
				fetch: configuredFetch,
			});
			logger.info({}, "[MCP Health] Connecting...");
			await client.connect(transport);
			logger.info({}, `[MCP Health] Connected successfully via HTTP`);

			// Connection successful, get tools
			const toolsResponse = await client.listTools();

			// Disconnect after getting tools
			await client.close();

			if (toolsResponse && toolsResponse.tools) {
				const response: HealthCheckResponse = {
					ready: true,
					tools: toolsResponse.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
					authRequired: false,
				};

				const res = new Response(JSON.stringify(response), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
				clearTimeout(timeoutId);
				return res;
			} else {
				const res = new Response(
					JSON.stringify({
						ready: false,
						error: "Connected but no tools available",
						authRequired: false,
					} as HealthCheckResponse),
					{
						status: 503,
						headers: { "Content-Type": "application/json" },
					}
				);
				clearTimeout(timeoutId);
				return res;
			}
		} catch (error) {
			httpError = error instanceof Error ? error : new Error(String(error));
			lastError = httpError;
			logger.warn(
				configuredRequest ? "Configured MCP connection failed" : lastError.message,
				"Streamable HTTP failed, trying SSE transport..."
			);

			// Close failed client
			try {
				await client?.close();
			} catch {
				// Ignore
			}

			// Try SSE transport
			try {
				logger.info({}, "[MCP Health] Trying SSE transport");
				client = new Client({
					name: "chat-ui-health-check",
					version: "1.0.0",
				});

				const sseTransport = new SSEClientTransport(baseUrl, {
					requestInit,
					fetch: configuredFetch,
				});
				logger.info({}, `[MCP Health] Connecting via SSE...`);
				await client.connect(sseTransport);
				logger.info({}, `[MCP Health] Connected successfully via SSE`);

				// Connection successful, get tools
				const toolsResponse = await client.listTools();

				// Disconnect after getting tools
				await client.close();

				if (toolsResponse && toolsResponse.tools) {
					const response: HealthCheckResponse = {
						ready: true,
						tools: toolsResponse.tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
						authRequired: false,
					};

					const res = new Response(JSON.stringify(response), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
					clearTimeout(timeoutId);
					return res;
				} else {
					const res = new Response(
						JSON.stringify({
							ready: false,
							error: "Connected but no tools available",
							authRequired: false,
						} as HealthCheckResponse),
						{
							status: 503,
							headers: { "Content-Type": "application/json" },
						}
					);
					clearTimeout(timeoutId);
					return res;
				}
			} catch (sseError) {
				lastError = sseError instanceof Error ? sseError : new Error(String(sseError));
				// Prefer the HTTP error when both failed so UI shows the primary failure (e.g., HTTP 500) instead
				// of the fallback SSE message.
				if (httpError) {
					lastError = new Error(
						`HTTP transport failed: ${httpError.message}; SSE fallback failed: ${lastError.message}`,
						{ cause: sseError instanceof Error ? sseError : undefined }
					);
				}
				logger.error(
					configuredRequest ? "Configured MCP connection failed" : lastError,
					"Both transports failed."
				);
			}
		}

		// Both transports failed
		let errorMessage = lastError?.message || "Failed to connect to MCP server";

		// Detect unauthorized to signal auth requirement
		const lower = (errorMessage || "").toLowerCase();
		const authRequired =
			lower.includes("unauthorized") ||
			lower.includes("forbidden") ||
			lower.includes("401") ||
			lower.includes("403");

		// Provide more helpful error messages
		if (authRequired) {
			errorMessage =
				"Authentication required. Provide appropriate Authorization headers in the server configuration.";
		} else if (errorMessage.includes("not valid JSON")) {
			errorMessage =
				"Server returned invalid response. This might not be a valid MCP endpoint. MCP servers should respond to POST requests at /mcp with JSON-RPC messages.";
		} else if (errorMessage.includes("fetch failed") || errorMessage.includes("ECONNREFUSED")) {
			errorMessage = `Cannot connect to ${url}. Please verify the server is running and accessible.`;
		} else if (errorMessage.includes("CORS")) {
			errorMessage = `CORS error. The MCP server needs to allow requests from this origin.`;
		}
		if (configuredRequest) {
			errorMessage = authRequired
				? "The configured MCP server requires valid deployment credentials."
				: "The configured MCP server health check failed. Review the private deployment settings.";
		}

		const res = new Response(
			JSON.stringify({
				ready: false,
				error: errorMessage,
				authRequired,
			} as HealthCheckResponse),
			{
				status: 503,
				headers: { "Content-Type": "application/json" },
			}
		);
		clearTimeout(timeoutId);
		return res;
	} catch (error) {
		if (error instanceof HealthTargetError) {
			return Response.json({ ready: false, error: error.message }, { status: 400 });
		}
		logger.error(
			configuredRequest ? "Configured MCP connection failed" : error,
			"MCP health check failed"
		);

		// Clean up client if it exists
		try {
			await client?.close();
		} catch {
			// Ignore
		}

		const response: HealthCheckResponse = {
			ready: false,
			error: configuredRequest
				? "The configured MCP server health check failed."
				: error instanceof Error
					? error.message
					: "Unknown error",
		};

		const res = new Response(JSON.stringify(response), {
			status: 503,
			headers: { "Content-Type": "application/json" },
		});
		return res;
	} finally {
		clearTimeout(timeoutId);
		controller?.abort();
		void client?.close().catch(() => {});
	}
};
