import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { digest } from './coordinator.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const key = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const clean = value => { const json=JSON.stringify(value); assert(json && Buffer.byteLength(json)<=262144,'receipt too large'); return JSON.parse(json); };
function signed(raw, op, pins, audience) {
  const event=clean(raw);
  assert(verifyEvent(event) && event.kind===27235 && pins.includes(event.pubkey) && isDeepStrictEqual(event.tags,[['d',audience]]),'signature, identity or audience mismatch');
  const body=JSON.parse(event.content); assert(body.op===op && body.data,'operation mismatch');
  return {event,data:body.data};
}
/** Controller attests measurements from its trusted runtime; workers cannot self-report cost or latency. */
export function createOutcomeReceipt({task,workspace,latencyMs,cost,audience,secretKey,createdAt=Math.floor(Date.now()/1000)}) {
  return finalizeEvent({kind:27235,created_at:createdAt,tags:[['d',audience]],content:JSON.stringify({op:'outcome-receipt',requestId:randomUUID(),data:{workspace,task,latencyMs,cost}})},secretKey);
}
/** Pinned, workspace-partitioned admission. Local database files require trusted host access. */
export class OutcomeMemory {
  constructor({path,workspace,audience,controllerPubkey,verifierPubkeys,workerPubkeys,maxRecords=1000}) {
    assert(typeof path==='string' && path && typeof workspace==='string' && workspace.length>0 && workspace.length<=128 && typeof audience==='string' && audience.length>0,'trusted path, workspace and audience required');
    assert(key(controllerPubkey) && Array.isArray(verifierPubkeys) && verifierPubkeys.length && verifierPubkeys.every(key) && Array.isArray(workerPubkeys) && workerPubkeys.length && workerPubkeys.every(key),'pinned roles required');
    const roles=[controllerPubkey,...verifierPubkeys,...workerPubkeys];assert(new Set(roles).size===roles.length,'roles must be separate');
    assert(Number.isSafeInteger(maxRecords) && maxRecords>0 && maxRecords<=10000,'invalid memory capacity');
    this.workspace=workspace;this.audience=audience;this.controller=controllerPubkey;this.verifiers=[...verifierPubkeys];this.workers=[...workerPubkeys];this.maxRecords=maxRecords;
    mkdirSync(path,{recursive:true,mode:0o700});this.path=join(path,`${digest(workspace)}.sqlite`);
    this.db=new DatabaseSync(this.path);chmodSync(this.path,0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY, hash TEXT); CREATE TABLE IF NOT EXISTS outcomes (seq INTEGER PRIMARY KEY, task TEXT UNIQUE NOT NULL, receipt TEXT NOT NULL)');
    const policy=digest({workspace,audience,controllerPubkey,verifierPubkeys,workerPubkeys,maxRecords});
    this.db.prepare('INSERT OR IGNORE INTO policy VALUES(1,?)').run(policy);
    if(this.db.prepare('SELECT hash FROM policy WHERE id=1').get().hash!==policy){this.db.close();throw new Error('persisted policy mismatch');}
  }
  validate(raw) {
    const {data,event}=signed(raw,'outcome-receipt',[this.controller],this.audience);
    assert(data.workspace===this.workspace,'workspace mismatch');
    const t=data.task;
    assert(t && t.status==='completed' && Number.isSafeInteger(t.epoch) && t.epoch>0,'completed task required');
    const {data:spec}=signed(t.submissionEnvelope,'submit',[this.controller],this.audience);
    const immutable={id:spec.id,capability:spec.capability,input:spec.input,vector:spec.vector,budget:spec.budget,maxAttempts:spec.maxAttempts??3,deadlineMs:spec.deadlineMs};
    assert(isDeepStrictEqual(t.spec,immutable) && digest(immutable)===t.inputHash,'immutable task mismatch');
    assert(typeof spec.id==='string' && typeof spec.capability==='string' && Array.isArray(spec.vector) && spec.vector.length>0 && spec.vector.length<=4096 && spec.vector.every(Number.isFinite) && spec.vector.some(x=>x!==0),'invalid task features');
    const result=signed(t.resultReceipt?.envelope,'result',this.workers,this.audience);
    const proof=signed(t.verification?.envelope,'verify',this.verifiers,this.audience);
    assert(result.event.pubkey===t.owner && result.event.pubkey===t.resultReceipt.worker,'worker mismatch');
    assert(result.data.taskId===spec.id && result.data.epoch===t.epoch && result.data.inputHash===t.inputHash,'result binding mismatch');
    assert(isDeepStrictEqual(result.data.artifact,t.artifact) && digest(t.artifact)===t.artifactHash,'artifact mismatch');
    assert(proof.data.taskId===spec.id && proof.data.epoch===t.epoch && proof.data.artifactHash===t.artifactHash && proof.data.accepted===true,'verification mismatch');
    assert(Number.isFinite(data.cost) && data.cost>=0 && data.cost===t.spent && data.cost<=spec.budget && Number.isFinite(data.latencyMs) && data.latencyMs>=0,'invalid controller measurements');
    return {id:`${this.workspace}:${spec.id}`,worker:result.event.pubkey,capability:spec.capability,vector:spec.vector,verified:true,cost:data.cost,latencyMs:data.latencyMs,artifactHash:t.artifactHash,verificationEvent:proof.event.id,receiptId:event.id};
  }
  admit(raw) {
    const receipt=clean(raw),row=this.validate(receipt);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT receipt FROM outcomes WHERE task=?').get(row.id);
      if(old){assert(JSON.parse(old.receipt).id===receipt.id,'task already admitted with different receipt');this.db.exec('COMMIT');return false;}
      this.db.prepare('INSERT INTO outcomes(task,receipt) VALUES(?,?)').run(row.id,JSON.stringify(receipt));
      this.db.prepare('DELETE FROM outcomes WHERE seq NOT IN (SELECT seq FROM outcomes ORDER BY seq DESC LIMIT ?)').run(this.maxRecords);
      this.db.exec('COMMIT');return true;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  history(){return this.db.prepare('SELECT receipt FROM outcomes ORDER BY seq').all().map(r=>this.validate(JSON.parse(r.receipt)));}
  close(){this.db.close();}
}
