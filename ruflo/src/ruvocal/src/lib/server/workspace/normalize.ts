import type { WorkspaceIntegration } from "$lib/types/Workspace";
import { isDeepStrictEqual } from "node:util";
import { ProbeError } from "./transport";

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ProbeError("malformed");
	return value as Record<string, unknown>;
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1e12) {
		throw new ProbeError("malformed");
	}
	return value;
}

function bool(value: unknown): boolean {
	if (typeof value !== "boolean") throw new ProbeError("malformed");
	return value;
}

function assertStatusMetadata(result: Record<string, unknown>): void {
	for (const key of ["isError", "success", "degraded"]) {
		if (result[key] !== undefined && typeof result[key] !== "boolean")
			throw new ProbeError("malformed");
	}
	if (
		result.exitCode !== undefined &&
		(typeof result.exitCode !== "number" || !Number.isSafeInteger(result.exitCode))
	)
		throw new ProbeError("malformed");
	if (
		result.isError === true ||
		result.success === false ||
		result.degraded === true ||
		(result.exitCode !== undefined && result.exitCode !== 0)
	)
		throw new ProbeError("runtime");
}

/**
 * The HTTP bridge can wrap the stdio tool result in a second MCP text envelope.
 * Unwrap at most three envelopes, retaining failure semantics at EVERY layer.
 * Check both representations when present so structured content cannot conceal
 * an error in nested text, or vice versa. Arbitrary prose is never status data.
 */
function unwrapToolData(value: unknown, envelopesRemaining: number): Record<string, unknown> {
	const result = record(value);
	assertStatusMetadata(result);
	const hasStructured = result.structuredContent !== undefined;
	const hasContent = result.content !== undefined;
	if (!hasStructured && !hasContent) return result;
	if (envelopesRemaining === 0) throw new ProbeError("malformed");
	let textData: Record<string, unknown> | undefined;
	if (hasContent) {
		if (!Array.isArray(result.content) || result.content.length !== 1)
			throw new ProbeError("malformed");
		const content = record(result.content[0]);
		if (content.type !== "text" || typeof content.text !== "string")
			throw new ProbeError("malformed");
		let parsed: unknown;
		try {
			parsed = JSON.parse(content.text);
		} catch {
			throw new ProbeError("malformed");
		}
		textData = unwrapToolData(parsed, envelopesRemaining - 1);
	}
	if (hasStructured) {
		const structuredData = unwrapToolData(result.structuredContent, envelopesRemaining - 1);
		// Ambiguous representations must not choose whichever happens to look healthy.
		if (textData && !isDeepStrictEqual(textData, structuredData)) throw new ProbeError("malformed");
		return structuredData;
	}
	return record(textData);
}

export function toolData(value: unknown): Record<string, unknown> {
	return unwrapToolData(value, 3);
}

export function normalizeSystem(data: Record<string, unknown>, integration: WorkspaceIntegration) {
	if (!["healthy", "degraded", "unhealthy"].includes(String(data.status)))
		throw new ProbeError("malformed");
	if (data.status !== "healthy" || data.success === false || data.degraded === true)
		integration.state = "degraded";
	integration.metrics.push(
		{ label: "Reported system state", value: String(data.status) },
		{ label: "Process uptime seconds", value: Math.floor(count(data.uptime) / 1000) }
	);
}

export function normalizePolicy(data: Record<string, unknown>, integration: WorkspaceIntegration) {
	if (!["legacy", "observe", "enforce"].includes(String(data.mode)))
		throw new ProbeError("malformed");
	const counts = record(data.counts);
	const ledgerValid = bool(record(data.ledger).valid);
	if (!ledgerValid || data.success === false || data.degraded === true)
		integration.state = "degraded";
	integration.metrics.push(
		{ label: "Policy mode", value: String(data.mode) },
		{ label: "Policy rules", value: count(counts.rules) },
		{ label: "Policy receipts", value: count(counts.receipts) },
		{ label: "Policy ledger", value: ledgerValid ? "Valid" : "Invalid" }
	);
}

export function normalizeFlywheel(
	data: Record<string, unknown>,
	integration: WorkspaceIntegration
) {
	if (!bool(data.success) || bool(data.degraded)) {
		integration.state = "degraded";
		integration.summary = "The MetaHarness status tool reported a failure or degraded integration.";
		return;
	}
	const payload = record(data.data);
	const state = record(payload.state);
	const ledger = record(payload.ledger);
	const valid = bool(ledger.valid);
	if (!valid) integration.state = "degraded";
	integration.metrics.push(
		{ label: "Promotion ledger", value: valid ? "Valid" : "Invalid" },
		{ label: "Promotion commits", value: count(ledger.commits) },
		{ label: "Serving epoch", value: count(state.servingEpoch) },
		{ label: "Recorded receipts", value: Object.keys(record(state.receiptStates)).length }
	);
	integration.summary = valid
		? "Flywheel state observed. Ledger integrity does not establish candidate quality or promotion authority."
		: "The flywheel reported an invalid promotion ledger.";
}

/** This endpoint reports the two rendezvous services, not fleet or desktop health. */
export function normalizeRuos(value: unknown, integration: WorkspaceIntegration) {
	const data = record(value);
	const ok = bool(data.ok);
	const services = record(data.services);
	const units = ["rustdesk-hbbs", "rustdesk-hbbr"];
	for (const unit of units) {
		if (typeof services[unit] !== "string") throw new ProbeError("malformed");
	}
	const active = units.filter((unit) => services[unit] === "active").length;
	integration.state = ok && active === units.length ? "available" : "degraded";
	integration.summary =
		integration.state === "available"
			? "Both ruOS rendezvous services report active. Fleet and desktop readiness are not measured."
			: "One or more ruOS rendezvous services are not confirmed active.";
	integration.metrics.push({ label: "Active rendezvous services", value: active });
}
