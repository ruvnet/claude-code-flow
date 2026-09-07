/** Private protected-host adapters. Deliberately absent from the public registry.
 * The embedding host authenticates both service envelopes, binds their metadata,
 * and consumes the existing operation nonce before invoking apply. Loopback,
 * possession of this factory, and an MCP context are not admission evidence.
 */
import type { MCPTool } from './types.js';
import { createNativeWhatsAppConsumer, type ConsumeResult } from '../memory/whatsapp-consume.js';

const MAX_BYTES = 256 * 1024;
const invalid = (): ConsumeResult => ({ outcome: 'denied', error: 'invalid_request' });

function argumentsFor(input: unknown, apply: boolean): input is Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const proto = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) return false;
  const expected = apply ? ['requestJson', 'serviceSeal'] : ['requestJson'];
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.length || keys.some(k => typeof k !== 'string' || !expected.includes(k))) return false;
  // JSON-RPC supplies data properties. Never execute accessor-supplied authority.
  for (const key of expected) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !('value' in d) || !d.enumerable || typeof d.value !== 'string' || !d.value.length) return false;
    if (Buffer.byteLength(d.value) > (key === 'serviceSeal' ? 16384 : MAX_BYTES)) return false;
  }
  return Buffer.byteLength(JSON.stringify(input)) <= MAX_BYTES;
}

/** Host-only construction: registry is ALREADY initialized; loader is independently
 * backed by reviewed current host configuration, never by request arguments.
 * Invalid initial configuration throws before any tools can be installed. Config
 * rotation invalidates this instance; reconstruct only through host lifecycle.
 * No environment lookup, initialization, migrations, cached reads or fallback.
 */
export function createPrivateWhatsAppConsumeTools(
  registry: unknown,
  loadCurrentConfig: () => unknown,
): readonly MCPTool[] {
  const consumer = createNativeWhatsAppConsumer(registry, loadCurrentConfig);
  function tool(apply: boolean): MCPTool {
    const properties: Record<string, unknown> = {
      requestJson: Object.freeze({ type: 'string', minLength: 1, maxLength: MAX_BYTES,
        description: 'Exact compact fixed consume JSON with original intent and dispatchId; no storage selectors or configuration.' }),
    };
    if (apply) properties.serviceSeal = Object.freeze({ type: 'string', minLength: 1, maxLength: 16384,
      description: 'Inner service seal over the exact requestJson bytes, admitted by the protected host.' });
    const inputSchema: MCPTool['inputSchema'] & { additionalProperties: false } = {
      type: 'object', additionalProperties: false, properties: Object.freeze(properties),
      required: Object.freeze(apply ? ['requestJson', 'serviceSeal'] : ['requestJson']) as unknown as string[],
    };
    return Object.freeze({
      name: apply ? 'whatsapp_consume_apply' : 'whatsapp_consume_prepare',
      description: apply
        ? 'Private protected-host operation: atomically consume the retained original human approval after authenticated admission. Use this fixed transaction instead of memory_store or shell writes; it preserves original proof, current reserved-state authority and replay checks. Not a public tool or permission to retry a send.'
        : 'Private protected-host operation: prepare a digest of current consume authority from one native transaction. Use this instead of cached memory reads for approval validation. Requires authenticated host admission and grants no consumption or permission to send.',
      inputSchema: Object.freeze(inputSchema), cacheable: false,
      handler: async (input: Record<string, unknown>): Promise<ConsumeResult> => {
        if (!argumentsFor(input, apply)) return invalid();
        // Preserve the signed string exactly: no parse/reserialize or normalization.
        // Preserve committed-held/unknown verbatim: no retry or success coercion.
        return apply ? consumer.apply(input.requestJson, input.serviceSeal) : consumer.prepare(input.requestJson);
      },
    });
  }
  return Object.freeze([tool(false), tool(true)]);
}
