import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { verifyEvent } from 'nostr-tools/pure';

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message) => { throw new Error(message); };
const pk = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const identifier = (s) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(s);
const finite = (x, min, max) => Number.isFinite(x) && x >= min && x <= max;
const boundedJSON = (x, limit = 16384) => {
  const s = JSON.stringify(x);
  if (!s || Buffer.byteLength(s) > limit) fail('payload size');
  return JSON.parse(s);
};
const freshState = () => ({tasks: {}, workers: {}, receipts: {}, log: [], lastNow: 0});

/** Single SQLite authority. Leases fence the accepted artifact transaction, not arbitrary external effects. */
export class Coordinator {
  constructor({dbPath, controllerPubkey, verifierPubkeys, workerPolicies, audience,
    leaseMs = 2000, heartbeatMs = 10000, clock = Date.now}) {
    if (!dbPath || !pk(controllerPubkey) || !identifier(audience)) fail('invalid coordinator config');
    if (!Array.isArray(verifierPubkeys) || !verifierPubkeys.length || !verifierPubkeys.every(pk)) fail('verifier required');
    if (!Array.isArray(workerPolicies) || !workerPolicies.length || workerPolicies.length > 100) fail('worker policies required');
    const identities = [controllerPubkey, ...verifierPubkeys, ...workerPolicies.map(w => w.pubkey)];
    if (new Set(identities).size !== identities.length) fail('roles must use separate identities');
    for (const w of workerPolicies) {
      if (!pk(w.pubkey) || !Array.isArray(w.capabilities) || !w.capabilities.length ||
          w.capabilities.length > 32 || !w.capabilities.every(identifier) || !finite(w.cost, 0, 1e6)) fail('invalid worker policy');
    }
    if (!Number.isInteger(leaseMs) || !finite(leaseMs, 50, 300000) || !finite(heartbeatMs, 50, 300000)) fail('invalid lease policy');
    this.controller = controllerPubkey;
    this.verifiers = new Set(verifierPubkeys);
    this.policies = new Map(workerPolicies.map(w => [w.pubkey, boundedJSON(w)]));
    this.audience = audience; this.leaseMs = leaseMs; this.heartbeatMs = heartbeatMs; this.clock = clock;
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS execution (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, state TEXT NOT NULL)');
    const policy = digest({controllerPubkey, verifierPubkeys, workerPolicies, audience, leaseMs, heartbeatMs});
    this.db.prepare('INSERT OR IGNORE INTO execution VALUES(1, ?, ?)').run(policy, JSON.stringify(freshState()));
    if (this.db.prepare('SELECT policy FROM execution WHERE id=1').get().policy !== policy) {
      this.db.close(); fail('persisted policy mismatch; use an explicit migration');
    }
  }
  close() { this.db.close(); }
  tasks() { return Object.values(JSON.parse(this.db.prepare('SELECT state FROM execution WHERE id=1').get().state).tasks); }
  execute(raw) {
    // Reparse: never trust caller objects, library verification-cache symbols, or body identity fields.
    const event = boundedJSON(raw, 32768);
    if (!verifyEvent(event) || event.kind !== 27235 || !Array.isArray(event.tags) ||
        event.tags.length !== 1 || JSON.stringify(event.tags[0]) !== JSON.stringify(['d', this.audience])) fail('invalid signature or audience');
    const now = this.clock();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(event.created_at) || Math.abs(event.created_at * 1000 - now) > 30000) fail('stale event');
    const body = boundedJSON(JSON.parse(event.content));
    if (!body || !identifier(body.requestId) || typeof body.op !== 'string' || !body.data ||
        typeof body.data !== 'object' || Array.isArray(body.data)) fail('invalid command');
    if (Object.keys(body).some(k => !['op','requestId','data'].includes(k))) fail('unexpected command field');
    const who = event.pubkey;
    if (who !== this.controller && !this.verifiers.has(who) && !this.policies.has(who)) fail('identity not allowed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = JSON.parse(this.db.prepare('SELECT state FROM execution WHERE id=1').get().state);
      if (now < state.lastNow) fail('clock moved backwards');
      const receiptKey = `${who}:${body.requestId}`;
      const old = state.receipts[receiptKey];
      if (old) {
        if (old.eventId !== event.id) fail('request id reused with different content');
        this.db.exec('COMMIT'); return old.response;
      }
      for (const [key, receipt] of Object.entries(state.receipts)) if (receipt.at < now - 61000) delete state.receipts[key];
      if (Object.keys(state.receipts).length >= 10000) fail('receipt capacity');
      this.expire(state, now);
      const response = boundedJSON(this.apply(state, who, body.op, body.data, now, event), 8 * 1024 * 1024);
      state.lastNow = now;
      state.receipts[receiptKey] = {eventId: event.id, at: now, response};
      state.log.push({eventId: event.id, pubkey: who, op: body.op, taskId: body.data.taskId ?? body.data.id ?? null, at: now});
      // This proof keeps bounded recent evidence. Completed task receipts remain with each task.
      if (state.log.length > 10000) state.log.splice(0, state.log.length - 10000);
      this.db.prepare('UPDATE execution SET state=? WHERE id=1').run(JSON.stringify(state));
      this.db.exec('COMMIT'); return response;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  expire(state, now) {
    for (const task of Object.values(state.tasks)) {
      if (['completed','cancelled','failed'].includes(task.status)) continue;
      if (task.spec.deadlineMs <= now) { task.status = 'failed'; task.reason = 'deadline'; task.assigned = null; continue; }
      if (task.status === 'queued' && task.assigned && task.assignedUntil <= now) task.assigned = null;
      if (['leased','submitted'].includes(task.status) && task.leaseUntil <= now) {
        task.status = task.attempts >= task.spec.maxAttempts ? 'failed' : 'queued';
        task.reason = 'lease expired'; task.assigned = null; task.owner = null;
        delete task.artifact; delete task.artifactHash;
      }
    }
  }
  apply(state, who, op, data, now, event) {
    const controller = () => { if (who !== this.controller) fail('controller required'); };
    const worker = () => { if (!this.policies.has(who)) fail('worker required'); return this.policies.get(who); };
    const getTask = () => {
      if (!identifier(data.taskId) || !Object.hasOwn(state.tasks, data.taskId)) fail('unknown task');
      return state.tasks[data.taskId];
    };
    const owned = () => {
      worker(); const t = getTask();
      if (t.owner !== who || t.epoch !== data.epoch || t.leaseUntil <= now || !['leased','submitted'].includes(t.status)) fail('stale fence or owner');
      return t;
    };
    if (op === 'submit') {
      controller();
      if (!identifier(data.id) || !identifier(data.capability) || !finite(data.budget, 0, 1e6) ||
          !finite(data.deadlineMs, now + 1, now + 86400000) || !Array.isArray(data.vector) ||
          data.vector.length < 1 || data.vector.length > 4096 || !data.vector.every(n => finite(n, -1e6, 1e6))) fail('invalid task');
      const maxAttempts = data.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || !finite(maxAttempts, 1, 10)) fail('invalid attempts');
      const spec = boundedJSON({id:data.id, capability:data.capability, input:data.input, vector:data.vector, budget:data.budget, maxAttempts, deadlineMs:data.deadlineMs});
      const inputHash = digest(spec);
      if (Object.hasOwn(state.tasks, spec.id)) {
        if (state.tasks[spec.id].inputHash !== inputHash) fail('task id conflict');
        return {taskId:spec.id, status:state.tasks[spec.id].status};
      }
      if (Object.keys(state.tasks).length >= 1000) fail('task capacity');
      Object.defineProperty(state.tasks, spec.id, {value:{spec,inputHash,submissionEnvelope:event,status:'queued',epoch:0,attempts:0,spent:0,assigned:null,owner:null},enumerable:true,writable:true,configurable:true});
      return {taskId:spec.id,status:'queued',inputHash};
    }
    if (op === 'register') {
      const policy = worker();
      if (!Array.isArray(data.capabilities) || data.capabilities.length > 32 || !data.capabilities.every(c => policy.capabilities.includes(c))) fail('capability escalation');
      state.workers[who] = {pubkey:who, capabilities:[...new Set(data.capabilities)],cost:policy.cost,lastSeen:now};
      return {pubkey:who,registered:true};
    }
    if (op === 'heartbeat') {
      worker(); if (!state.workers[who]) fail('register first');
      state.workers[who].lastSeen = now; return {alive:true};
    }
    if (op === 'assign') {
      controller(); const t = getTask(), w = state.workers[data.worker];
      if (t.status !== 'queued' || !w || !this.policies.has(data.worker) || w.lastSeen + this.heartbeatMs <= now ||
          !w.capabilities.includes(t.spec.capability) || w.cost + t.spent > t.spec.budget ||
          Object.values(state.tasks).some(x => (['leased','submitted'].includes(x.status) && x.owner === data.worker) || (x.status === 'queued' && x.assigned === data.worker && x !== t))) fail('worker ineligible');
      t.assigned = data.worker; t.assignedUntil = Math.min(now + this.leaseMs, t.spec.deadlineMs); return {taskId:t.spec.id,assigned:data.worker};
    }
    if (op === 'wait') {
      worker(); if (!state.workers[who]) fail('register first');
      return {ready:Object.values(state.tasks).some(t => t.status === 'queued' && t.assigned === who)};
    }
    if (op === 'pull') {
      worker(); const w = state.workers[who];
      if (!w) fail('register first'); w.lastSeen = now;
      if (Object.values(state.tasks).some(t => ['leased','submitted'].includes(t.status) && t.owner === who)) return {task:null};
      const t = Object.values(state.tasks).find(t => t.status === 'queued' && t.assigned === who);
      if (!t) return {task:null};
      if (!w.capabilities.includes(t.spec.capability) || w.cost + t.spent > t.spec.budget || t.attempts >= t.spec.maxAttempts) fail('worker ineligible');
      t.epoch++; t.attempts++; t.spent += w.cost; t.owner = who; t.status = 'leased'; t.leaseUntil = Math.min(now + this.leaseMs, t.spec.deadlineMs);
      return {task:{...t.spec,inputHash:t.inputHash,epoch:t.epoch,leaseUntil:t.leaseUntil}};
    }
    if (op === 'renew') {
      const t = owned(); if (t.status !== 'leased') fail('cannot renew submitted artifact');
      t.leaseUntil = Math.min(now + this.leaseMs, t.spec.deadlineMs); state.workers[who].lastSeen = now;
      return {leaseUntil:t.leaseUntil};
    }
    if (op === 'result') {
      const t = owned(); if (data.inputHash !== t.inputHash) fail('input hash mismatch');
      const artifact = boundedJSON(data.artifact), artifactHash = digest(artifact);
      if (t.status === 'submitted' && artifactHash !== t.artifactHash) fail('artifact conflict');
      t.artifact = artifact; t.artifactHash = artifactHash; t.status = 'submitted';
      t.resultReceipt = {worker:who,epoch:t.epoch,inputHash:t.inputHash,artifactHash,submittedAt:now,envelope:event};
      return {status:'submitted',artifactHash};
    }
    if (op === 'verify') {
      if (!this.verifiers.has(who)) fail('verifier required'); const t = getTask();
      if (t.status === 'completed' && t.epoch === data.epoch && t.artifactHash === data.artifactHash && data.accepted === true) return {status:'completed'};
      if (t.status !== 'submitted' || t.epoch !== data.epoch || t.artifactHash !== data.artifactHash || t.leaseUntil <= now || typeof data.accepted !== 'boolean') fail('invalid verification fence');
      t.verification = {verifier:who,artifactHash:t.artifactHash,epoch:t.epoch,accepted:data.accepted,at:now,envelope:event};
      t.status = data.accepted ? 'completed' : (t.attempts >= t.spec.maxAttempts ? 'failed' : 'queued');
      t.assigned = null;
      if (!data.accepted) {t.owner = null; delete t.artifact; delete t.artifactHash;}
      return {status:t.status};
    }
    if (op === 'cancel') {
      controller(); const t = getTask();
      if (t.status === 'completed') fail('completed task cannot cancel');
      t.status = 'cancelled'; t.epoch++; t.assigned = null; t.owner = null; return {status:'cancelled'};
    }
    if (op === 'task_get' || op === 'task_list') {
      if (who !== this.controller && !this.verifiers.has(who)) fail('task access requires controller or verifier');
      if (op === 'task_get') return {task:getTask()};
      const limit=data.limit ?? 25;
      if (!Number.isInteger(limit) || limit<1 || limit>100) fail('invalid page limit');
      if (data.cursor !== undefined && (typeof data.cursor!=='string' || !/^\d{1,6}$/.test(data.cursor))) fail('invalid cursor');
      const offset=Number(data.cursor ?? 0), tasks=Object.values(state.tasks);
      return {tasks:tasks.slice(offset,offset+limit).map(t=>({id:t.spec.id,taskId:t.spec.id,status:t.status,owner:t.owner,epoch:t.epoch,capability:t.spec.capability,spent:t.spent,artifactHash:t.artifactHash ?? null,verified:t.status==='completed' && t.verification?.accepted===true})),nextCursor:offset+limit<tasks.length?String(offset+limit):null};
    }
    if (op === 'status' || op === 'worker_list') {
      if (who !== this.controller && !this.verifiers.has(who)) fail('status requires controller or verifier');
      const workers=Object.values(state.workers).map(w => ({...w,available:w.lastSeen + this.heartbeatMs > now && !Object.values(state.tasks).some(t => (['leased','submitted'].includes(t.status) && t.owner === w.pubkey) || (t.status === 'queued' && t.assigned === w.pubkey))}));
      return op === 'worker_list' ? {workers} : {tasks:Object.values(state.tasks),workers};
    }
    fail('unknown operation');
  }
}
