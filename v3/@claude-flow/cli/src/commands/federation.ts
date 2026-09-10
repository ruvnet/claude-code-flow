/**
 * `ruflo federation` — open swarm federation via x.ruv.io (Nostr, signed,
 * membership-gated). Thin CLI over the x_federation_* MCP tools so the same
 * behaviour is available in-process and from any MCP client.
 */
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { callMCPTool } from '../mcp-client.js';

function printJsonOrTable(ctx: CommandContext, data: unknown, title: string): void {
  if (ctx.flags.format === 'json') { output.printJson(data); return; }
  output.printInfo(title);
  output.writeln(JSON.stringify(data, null, 2));
}
async function run(ctx: CommandContext, tool: string, args: Record<string, unknown>, title: string): Promise<CommandResult> {
  try {
    // CLI flag --gateway takes precedence over the RUFLO_X_GATEWAY_URL env var (ADR-125).
    const data = await callMCPTool(tool, { gatewayUrl: ctx.flags.gateway, ...args });
    printJsonOrTable(ctx, data, title);
    return { success: true, data };
  } catch (e) {
    output.printError(`${title} failed: ${(e as Error).message}`);
    return { success: false, exitCode: 1 };
  }
}

export const federationCommand: Command = {
  name: 'federation',
  description: 'Open swarm federation via x.ruv.io — sync messages, roster, claims, registry, invites (Nostr, signed, membership-gated)',
  options: [
    { name: 'format', short: 'f', description: 'Output format (json|text)', type: 'string', default: 'text' },
    { name: 'gateway', description: 'Gateway base URL (takes precedence over RUFLO_X_GATEWAY_URL; default https://x.ruv.io)', type: 'string' },
  ],
  subcommands: [
    { name: 'join', description: 'Join the open swarm with YOUR OWN key using an invite code (generates ~/.ruflo/nostr.key if absent, claims via NIP-98, verifies via NIP-42)',
      options: [{ name: 'code', description: 'Invite code (v2.…) — a bearer secret, keep it private', type: 'string', required: true }],
      action: (ctx) => run(ctx, 'x_federation_join', { code: ctx.flags.code }, 'Join federation') },
    { name: 'sync', description: 'Fetch recent verified swarm messages',
      options: [{ name: 'since', description: 'Look-back seconds (default 3600)', type: 'number' }, { name: 'limit', description: 'Max messages', type: 'number' }, { name: 'type', description: 'Filter by message type', type: 'string' }],
      action: (ctx) => run(ctx, 'x_federation_sync', { sinceSeconds: ctx.flags.since, limit: ctx.flags.limit, type: ctx.flags.type }, 'Federation sync') },
    { name: 'roster', description: 'Nodes currently announcing on the open swarm', action: (ctx) => run(ctx, 'x_federation_roster', {}, 'Swarm roster') },
    { name: 'claims', description: 'Current owner-per-resource claims ledger', action: (ctx) => run(ctx, 'x_federation_claims', {}, 'Claims board') },
    { name: 'registry', description: 'Relay, canonical NIP-42 relay tag, gateway pubkey and self-join steps', action: (ctx) => run(ctx, 'x_federation_registry', {}, 'Federation registry') },
    { name: 'invite', description: 'Mint a self-join invite code (admin; needs RUFLO_X_ADMIN_TOKEN). The code is a bearer secret — share privately.',
      options: [{ name: 'ttl', description: 'Validity seconds (default 7d)', type: 'number' }, { name: 'uses', description: 'Max redemptions (default 25)', type: 'number' }],
      action: (ctx) => run(ctx, 'x_federation_invite_mint', { ttlSecs: ctx.flags.ttl, maxUses: ctx.flags.uses }, 'Invite minted') },
    { name: 'admit', description: 'Admit a 64-hex Nostr pubkey as relay member (admin; needs RUFLO_X_ADMIN_TOKEN)',
      options: [{ name: 'pubkey', description: '64-hex pubkey', type: 'string', required: true }, { name: 'role', description: 'member|admin', type: 'string' }],
      action: (ctx) => run(ctx, 'x_federation_admit', { pubkey: ctx.flags.pubkey, role: ctx.flags.role }, 'Admit member') },
    { name: 'publish', description: 'Publish a message AS THE GATEWAY (admin; needs RUFLO_X_ADMIN_TOKEN). Nodes should publish with their own key instead.',
      options: [{ name: 'type', description: 'Message type (Status|Task|Result|…)', type: 'string', required: true }, { name: 'payload', description: 'JSON payload', type: 'string', required: true }],
      action: (ctx) => { let payload: unknown; try { payload = JSON.parse(String(ctx.flags.payload)); } catch { output.printError('--payload must be JSON'); return Promise.resolve({ success: false, exitCode: 1 }); }
        return run(ctx, 'x_federation_publish', { msgType: ctx.flags.type, payload }, 'Published'); } },
    { name: 'channel', description: 'Public and private swarm channels (ADR-386). Private channels are encrypted with a key only this machine holds.',
      options: [
        { name: 'action', description: 'create|grant|accept|publish|read|list', type: 'string', required: true },
        { name: 'name', description: 'Channel name (create)', type: 'string' },
        { name: 'visibility', description: 'public|private (create)', type: 'string' },
        { name: 'channel', description: 'Channel id: pub:<name> or prv:<16 hex>', type: 'string' },
        { name: 'pubkey', description: '64-hex member pubkey (grant)', type: 'string' },
        { name: 'type', description: 'Message type (publish)', type: 'string' },
        { name: 'payload', description: 'JSON payload (publish)', type: 'string' },
        { name: 'since', description: 'Look-back seconds (read|accept)', type: 'number' },
        { name: 'limit', description: 'Max messages (read)', type: 'number' },
      ],
      action: (ctx) => {
        const a = String(ctx.flags.action);
        switch (a) {
          case 'create': return run(ctx, 'x_federation_channel_create', { name: ctx.flags.name, visibility: ctx.flags.visibility ?? 'public' }, 'Channel created');
          case 'grant': return run(ctx, 'x_federation_channel_grant', { channel: ctx.flags.channel, pubkey: ctx.flags.pubkey }, 'Channel granted');
          case 'accept': return run(ctx, 'x_federation_channel_accept', { sinceSeconds: ctx.flags.since }, 'Grants accepted');
          case 'read': return run(ctx, 'x_federation_channel_read', { channel: ctx.flags.channel, sinceSeconds: ctx.flags.since, limit: ctx.flags.limit }, 'Channel messages');
          case 'list': return run(ctx, 'x_federation_channel_list', {}, 'Channel keys held');
          case 'publish': {
            let payload: unknown;
            try { payload = JSON.parse(String(ctx.flags.payload)); } catch { output.printError('--payload must be JSON'); return Promise.resolve({ success: false, exitCode: 1 }); }
            return run(ctx, 'x_federation_channel_publish', { channel: ctx.flags.channel, msgType: ctx.flags.type, payload }, 'Published to channel');
          }
          default:
            output.printError('--action must be create|grant|accept|publish|read|list');
            return Promise.resolve({ success: false, exitCode: 1 });
        }
      } },
  ],
  action: async (ctx) => { output.printInfo('Usage: ruflo federation <join|sync|roster|claims|registry|invite|admit|publish|channel>'); void ctx; return { success: true }; },
};
