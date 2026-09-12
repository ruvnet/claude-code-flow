// SPDX-License-Identifier: MIT
/** Opt-in MidStream/Ruflo bridge. Callbacks are trusted code, not a sandbox. */
export type ReflexKind = 'Interrupt' | 'Backchannel' | 'Cancel' | 'Observation' | 'CommitBoundary';
export interface ReflexWireEvent { sequence: string; at_micros: string; kind: ReflexKind }
export interface ReflexWireHandoff {
  version: 1; authority: 'none'; session_id: string; latest_sequence: string;
  queued_events: readonly ReflexWireEvent[];
  interrupt_sequence: string | null; cancel_sequence: string | null;
  cancelled_work_units: string; dropped_events: string;
}
export interface ToolProposal { readonly name: string; readonly argumentsJson: string }
export interface TurnContext {
  readonly signal: AbortSignal; readonly generation: number;
  emit(text: string): boolean;
  tool(proposal: ToolProposal): Promise<unknown>;
  spawn(work: (context: TurnContext) => Promise<unknown>): Promise<unknown>;
}
export interface ToolBoundary {
  authorize(proposal: ToolProposal, context: TurnContext): Promise<boolean>;
  /** Must propagate signal and revalidate at the actual external commit boundary. */
  execute(proposal: ToolProposal, context: TurnContext): Promise<unknown>;
}
export type TurnOutcome<T> =
  | { status: 'completed'; value: T; generation: number }
  | { status: 'cancelled' | 'failed'; code: string; generation: number };
export interface TurnHandle<T> {
  generation: number; signal: AbortSignal; result: Promise<TurnOutcome<T>>;
  /** Settles only after the root, delegated work, and tool calls have exited. */
  settled: Promise<void>;
}
export interface RealtimeOptions {
  onToken?: (text: string, generation: number) => void;
  tools?: ToolBoundary;
  timeoutMs?: number; maxOutputChars?: number; maxToolCalls?: number; maxDelegates?: number;
}
interface Active {
  generation: number; controller: AbortController; cancel: (code: string) => void;
  cancelled: boolean; rootDone: boolean; outputChars: number; toolCalls: number;
  delegateCalls: number; children: Set<Promise<unknown>>; settled: Promise<void>;
}
const kinds = new Set<ReflexKind>(['Interrupt', 'Backchannel', 'Cancel', 'Observation', 'CommitBoundary']);
const U64 = 18446744073709551615n;
function integer(value: unknown, max: number, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('INVALID_LIMIT');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HANDOFF');
  return value as Record<string, unknown>;
}
function u64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('INVALID_U64');
  const number = BigInt(value);
  if (number > U64) throw new Error('INVALID_U64');
  return number;
}
function sessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:]{1,128}$/.test(value)) throw new Error('INVALID_SESSION');
}
/** Call only on messages from an authenticated, session-bound MidStream channel. */
export function validateReflexHandoff(value: unknown, expectedSession: string): ReflexWireHandoff {
  const h = record(value);
  if (h.version !== 1 || h.authority !== 'none' || h.session_id !== expectedSession) throw new Error('WRONG_HANDOFF_SCOPE');
  sessionId(h.session_id);
  const latest = u64(h.latest_sequence);
  for (const key of ['interrupt_sequence', 'cancel_sequence']) {
    if (h[key] !== null && (u64(h[key]) === 0n || u64(h[key]) > latest)) throw new Error('INVALID_CONTROL_WATERMARK');
  }
  u64(h.cancelled_work_units); u64(h.dropped_events);
  if (!Array.isArray(h.queued_events) || h.queued_events.length > 4096) throw new Error('INVALID_EVENT_COUNT');
  let previous = 0n;
  for (const raw of h.queued_events) {
    const event = record(raw); const sequence = u64(event.sequence);
    u64(event.at_micros);
    if (sequence <= previous || sequence > latest || !kinds.has(event.kind as ReflexKind)) throw new Error('INVALID_EVENT_ORDER');
    if (event.kind === 'Cancel' && (h.cancel_sequence === null || sequence > u64(h.cancel_sequence))) throw new Error('MISSING_CANCEL_WATERMARK');
    if (event.kind === 'Interrupt' && (h.interrupt_sequence === null || sequence > u64(h.interrupt_sequence))) throw new Error('MISSING_INTERRUPT_WATERMARK');
    previous = sequence;
  }
  return value as ReflexWireHandoff;
}

/** One session, one physically active generation, bounded work, explicit restart. */
export class RealtimeSession {
  private active: Active | undefined;
  private generation = 0;
  private latest = 0n;
  private dropped = 0n;
  private closed = false;
  private reconcile = false;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly maxToolCalls: number;
  private readonly maxDelegates: number;
  private readonly onToken: RealtimeOptions['onToken'];
  private readonly tools: ToolBoundary | undefined;
  private counts = { cancellations: 0, staleOutputs: 0, rejectedHandoffs: 0, deniedTools: 0, startedTools: 0 };

  constructor(readonly session: string, options: RealtimeOptions = {}) {
    sessionId(session);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputChars = options.maxOutputChars ?? 1_048_576;
    this.maxToolCalls = options.maxToolCalls ?? 32;
    this.maxDelegates = options.maxDelegates ?? 16;
    integer(this.timeoutMs, 300_000, 1); integer(this.maxOutputChars, 16_777_216, 1);
    integer(this.maxToolCalls, 256); integer(this.maxDelegates, 256);
    this.onToken = options.onToken; this.tools = options.tools;
  }

  get telemetry() { return Object.freeze({ ...this.counts, busy: this.active !== undefined, needsReconcile: this.reconcile }); }

  /** Stops local publication synchronously; cooperative work receives AbortSignal. */
  acceptHandoff(value: unknown) {
    if (this.closed) throw new Error('SESSION_CLOSED');
    let h: ReflexWireHandoff;
    try { h = validateReflexHandoff(value, this.session); }
    catch (error) { this.counts.rejectedHandoffs++; throw error; }
    const next = u64(h.latest_sequence), drops = u64(h.dropped_events);
    if (next <= this.latest) return { status: 'stale' as const, authority: 'none' as const };
    if (drops < this.dropped) throw new Error('COUNTER_REGRESSION');
    const cancel = h.cancel_sequence !== null && u64(h.cancel_sequence) > this.latest;
    const pause = h.interrupt_sequence !== null && u64(h.interrupt_sequence) > this.latest;
    const overflow = drops > this.dropped;
    this.latest = next; this.dropped = drops;
    if (overflow) this.reconcile = true;
    if (cancel || pause || overflow) this.stop(cancel ? 'CANCEL' : pause ? 'INTERRUPT' : 'OVERFLOW');
    return { status: 'accepted' as const, acknowledged: cancel || pause || h.queued_events.some(e => e.kind === 'Backchannel'), needsReconcile: this.reconcile, authority: 'none' as const };
  }

  /** Trusted host acknowledgement of a fresh full snapshot, never an agent decision. */
  reconcileSnapshot(snapshotDigest: string, throughSequence: string): void {
    if (!/^[a-f0-9]{64}$/.test(snapshotDigest) || u64(throughSequence) !== this.latest) throw new Error('INVALID_SNAPSHOT');
    if (this.active) throw new Error('WORK_NOT_QUIESCENT');
    this.reconcile = false;
  }

  start<T>(input: string, reasoner: (input: string, context: TurnContext) => Promise<T>): TurnHandle<T> {
    if (this.closed) throw new Error('SESSION_CLOSED');
    if (this.active) throw new Error('WORK_NOT_QUIESCENT');
    if (this.reconcile) throw new Error('SNAPSHOT_REQUIRED');
    if (typeof input !== 'string' || input.length > 1_048_576 || typeof reasoner !== 'function') throw new Error('INVALID_TURN');
    if (this.generation === Number.MAX_SAFE_INTEGER) throw new Error('GENERATION_EXHAUSTED');
    const generation = ++this.generation, controller = new AbortController();
    let resolve!: (value: TurnOutcome<T>) => void;
    let finish!: () => void;
    const result = new Promise<TurnOutcome<T>>(r => { resolve = r; });
    const settled = new Promise<void>(r => { finish = r; });
    const active: Active = { generation, controller, cancelled: false, rootDone: false, outputChars: 0, toolCalls: 0, delegateCalls: 0, children: new Set(), settled,
      cancel: code => { resolve({ status: 'cancelled', code, generation }); } };
    this.active = active;
    const live = () => {
      if (this.active !== active || active.cancelled || controller.signal.aborted) throw new Error('TURN_CANCELLED');
    };
    const track = <R>(promise: Promise<R>): Promise<R> => {
      active.children.add(promise);
      // Observe rejection even when a caller forgets to await a child. No detached rejection.
      void promise.then(() => active.children.delete(promise), () => { active.children.delete(promise); this.stopActive(active, 'CHILD_FAILED'); });
      return promise;
    };
    const context: TurnContext = Object.freeze({
      signal: controller.signal, generation,
      emit: (text: string) => {
        if (this.active !== active || active.cancelled || active.rootDone) { this.counts.staleOutputs++; return false; }
        if (typeof text !== 'string' || text.length > this.maxOutputChars - active.outputChars) { this.stopActive(active, 'OUTPUT_LIMIT'); return false; }
        active.outputChars += text.length;
        this.onToken?.(text, generation);
        return true;
      },
      tool: (proposal: ToolProposal) => {
        live();
        if (active.rootDone || ++active.toolCalls > this.maxToolCalls) throw new Error('TOOL_LIMIT');
        if (!proposal || typeof proposal.name !== 'string' || !/^[A-Za-z0-9._:]{1,128}$/.test(proposal.name) || typeof proposal.argumentsJson !== 'string' || proposal.argumentsJson.length > 65_536) throw new Error('INVALID_TOOL');
        const frozen = Object.freeze({ name: proposal.name, argumentsJson: proposal.argumentsJson });
        return track((async () => {
          if (!this.tools) { this.counts.deniedTools++; throw new Error('TOOL_DENIED'); }
          const allowed = await this.tools.authorize(frozen, context);
          live(); // Recheck AFTER asynchronous policy lookup, immediately before execution.
          if (allowed !== true) { this.counts.deniedTools++; throw new Error('TOOL_DENIED'); }
          this.counts.startedTools++;
          return this.tools.execute(frozen, context);
        })());
      },
      spawn: (work: (context: TurnContext) => Promise<unknown>) => {
        live();
        if (active.rootDone || ++active.delegateCalls > this.maxDelegates) throw new Error('DELEGATE_LIMIT');
        return track(Promise.resolve().then(() => { live(); return work(context); }));
      },
    });
    const timer = setTimeout(() => this.stopActive(active, 'DEADLINE'), this.timeoutMs);
    void (async () => {
      try {
        live();
        const value = await reasoner(input, context);
        active.rootDone = true;
        await Promise.allSettled([...active.children]);
        live();
        resolve({ status: 'completed', value, generation });
      } catch {
        if (!active.cancelled) resolve({ status: 'failed', code: 'REASONER_FAILED', generation });
      } finally {
        active.rootDone = true;
        // A failed root must not leave authorized children behind.
        if (!controller.signal.aborted) controller.abort();
        await Promise.allSettled([...active.children]);
        clearTimeout(timer);
        if (this.active === active) this.active = undefined;
        finish();
      }
    })();
    return { generation, signal: controller.signal, result, settled };
  }

  private stopActive(active: Active, code: string): void {
    if (this.active !== active || active.cancelled) return;
    active.cancelled = true; this.counts.cancellations++;
    active.cancel(code); // Logical cancellation is not a physical stop attestation.
    active.controller.abort();
  }
  stop(code = 'CANCEL'): void { if (this.active) this.stopActive(this.active, code); }
  close(): void { this.closed = true; this.stop('CLOSED'); }
  async waitForQuiescence(timeoutMs = 1_000): Promise<'STOPPED' | 'INCOMPLETE'> {
    integer(timeoutMs, 300_000, 1);
    const active = this.active;
    if (!active) return 'STOPPED';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        active.settled.then(() => 'STOPPED' as const),
        new Promise<'INCOMPLETE'>(resolve => { timer = setTimeout(() => resolve('INCOMPLETE'), timeoutMs); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

/** Bounded text stream consumption with real reader cancellation and listener cleanup. */
export async function consumeRealtimeBody(body: ReadableStream<Uint8Array>, context: TurnContext): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  context.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (context.signal.aborted) return;
    while (!context.signal.aborted) {
      const item = await reader.read();
      if (context.signal.aborted || item.done) break;
      if (!context.emit(decoder.decode(item.value, { stream: true }))) break;
    }
    if (!context.signal.aborted) { const tail = decoder.decode(); if (tail) context.emit(tail); }
  } finally {
    context.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
