/** Fixed business validation; no caller-supplied authority rows or replacement values. */
import { authorityTimestamp as date, readAuthorityRows } from './authority-snapshot.js';
import { type Obj, requireThat as need, identifier, groupId, safe, exact, sha } from './whatsapp-approve-proof.js';
const amount = (v: unknown): number => { need(typeof v === 'number' && Number.isFinite(v) && v >= 0); return v; };
const same = (a: Obj,b: Obj): boolean => Object.keys(b).every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
const command = (s: unknown): boolean => typeof s === 'string' && /^\/[a-z][a-z0-9_-]{0,31}$/.test(s);
function route(p: Obj): void {
  need(p && groupId(p.agentMemberId) && Array.isArray(p.allowedCommands) && p.allowedCommands.length > 0 && p.allowedCommands.length <= 32
    && p.allowedCommands.every(command) && new Set(p.allowedCommands).size === p.allowedCommands.length
    && Array.isArray(p.allowedTools) && p.allowedTools.length <= 32 && p.allowedTools.every((s: unknown) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(s))
    && new Set(p.allowedTools).size === p.allowedTools.length && typeof p.harnessRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,126}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.harnessRef)
    && ['low','medium','high'].includes(p.inferenceTier)); amount(p.maxUsdPerInvocation);
}
function member(m: Obj,c: string,id: string,kind: string): void {
  need(m && m.id === id && m.companyId === c && m.kind === kind && m.status === 'active' && safe(m.identityRef));
}
function ledger(l: Obj,c: string,g: string): Obj[] {
  need(l && l.companyId === c && l.groupId === g && Array.isArray(l.reservations) && l.reservations.length <= 10000);
  date(l.updatedAt); const ids = new Set(); const receipts = new Set(); let spent=0, reserved=0;
  for (const r of l.reservations) {
    need(r && groupId(r.reservationId) && !ids.has(r.reservationId)); ids.add(r.reservationId);
    route(r.routePolicy); need(r.agentMemberId === r.routePolicy.agentMemberId && safe(r.sourceEventId) && safe(r.inboundEnvelopeId)
      && r.routePolicy.allowedCommands.includes(r.command) && amount(r.reservedUsd) <= amount(r.routePolicy.maxUsdPerInvocation));
    amount(r.budgetCapUsd); for (const k of ['assignmentUpdatedAt','createdAt','updatedAt']) date(r[k]);
    if (r.status === 'recorded') { need(groupId(r.receiptId) && !receipts.has(r.receiptId) && amount(r.recordedUsd) <= amount(r.reservedUsd)); receipts.add(r.receiptId); spent += r.recordedUsd; }
    else { need(['reserved','released'].includes(r.status) && r.receiptId === null && r.recordedUsd === null); if (r.status === 'reserved') reserved += r.reservedUsd; }
  }
  need(Number.isFinite(spent) && Number.isFinite(reserved) && Math.abs(spent-amount(l.spentUsd)) <= 1e-9 && Math.abs(reserved-amount(l.reservedUsd)) <= 1e-9);
  return l.reservations;
}
export function intent(d: Obj): Obj { const a=d.assertion; return {intentId:a.intentId,reservationId:a.reservationId,agentMemberId:a.agentMemberId,agentBbsEnvelopeId:a.agentBbsEnvelopeId,payloadSha256:a.payloadSha256}; }
export function state(db: any,d: Obj,now: number,check: () => void) {
  const c=d.companyId,g=d.groupId,a=d.assertion;
  // Bootstrap is a real row read INSIDE this transaction. It is reused, not hidden.
  const first=readAuthorityRows(db,{companyId:c,selectors:[{kind:'assignment',groupId:g}]},now,check);
  const assignment=JSON.parse(first.records[0].value!);
  need(assignment.companyId === c && assignment.groupId === g && assignment.status === 'active'
    && assignment.managementApprovalMode === 'required' && identifier(assignment.ownerMemberId)
    && Number.isSafeInteger(assignment.memoryRetentionHours) && assignment.memoryRetentionHours >= 0 && assignment.memoryRetentionHours <= 8760);
  date(assignment.updatedAt); amount(assignment.budgetCapUsd);
  need(Array.isArray(assignment.agents) && assignment.agents.length > 0 && assignment.agents.length <= 16);
  const agents=new Set(), commands=new Set();
  for (const p of assignment.agents) { route(p); need(identifier(p.agentMemberId) && !agents.has(p.agentMemberId)); agents.add(p.agentMemberId);
    for (const cmd of p.allowedCommands) { need(!commands.has(cmd)); commands.add(cmd); } }
  const owner=assignment.ownerMemberId;
  const selectors: Obj[]=[{kind:'company'},{kind:'member',memberId:owner},{kind:'member',memberId:a.agentMemberId},
    {kind:'settings',memberId:a.agentMemberId},{kind:'spend',groupId:g},{kind:'request',groupId:g,reservationId:a.reservationId},
    {kind:'approval',groupId:g,reservationId:a.reservationId,allowAbsent:true},{kind:'jti',jti:a.jti,allowAbsent:true}];
  if (d.approvedByMemberId !== owner) selectors.push({kind:'member',memberId:d.approvedByMemberId},{kind:'executive',memberId:d.approvedByMemberId});
  const rest=readAuthorityRows(db,{companyId:c,selectors},now,check);
  const records=[...first.records,...rest.records];
  const vals=rest.records.map(r => r.value === null ? null : JSON.parse(r.value));
  const [company,human,agent,settings,spend,published,approval,jti]=vals;
  need(company.id === c && company.status === 'active'); member(human,c,owner,'human'); member(agent,c,a.agentMemberId,'agent');
  need(settings && ['suggest-only','auto-act-within-budget'].includes(settings.autonomy));
  const approver=d.approvedByMemberId === owner ? human : vals[8]; member(approver,c,d.approvedByMemberId,'human');
  need(approver.identityRef === `slack:${a.humanSubject.userId}`);
  if (d.approvedByMemberId !== owner) { const e=vals[9]; need(e && e.version === 1 && e.companyId === c && e.memberId === d.approvedByMemberId
    && e.identityRef === approver.identityRef && e.capability === 'executive' && e.status === 'active' && e.source === 'trusted-seed'); }
  need(approval === null && jti === null, 'approval_replayed');
  const rows=ledger(spend,c,g); const row=rows.find(r => r.reservationId === a.reservationId);
  need(row && row.status === 'reserved' && row.agentMemberId === a.agentMemberId);
  const selected=assignment.agents.find((p: Obj) => p.allowedCommands.includes(row.command));
  need(selected && same(row.routePolicy,selected) && row.assignmentUpdatedAt === assignment.updatedAt
    && row.budgetCapUsd === assignment.budgetCapUsd && amount(spend.spentUsd)+amount(spend.reservedUsd) <= assignment.budgetCapUsd);
  need(published && published.version === 1 && published.companyId === c && published.groupId === g
    && exact(published.intent,Object.keys(intent(d))) && same(published.intent,intent(d))
    && published.recipientMemberId === d.approvedByMemberId && published.recipient === approver.identityRef
    && published.eventState === 'published' && typeof published.eventDelivered === 'boolean' && safe(published.eventEnvelopeId));
  const created=date(published.createdAt), released=date(published.publishedAt);
  need(created <= released && released <= now);
  const encoded=JSON.stringify({companyId:c,records});
  need(Buffer.byteLength(encoded) <= 2*1024*1024,'byte_limit');
  const returned=first.rowsObserved+rest.rowsObserved;
  return {digest:sha(encoded),records,counts:{logicalRecords:records.length,bootstrapRecords:1,rowsObserved:returned,
    recordRowsRead:2*returned,recordStatements:records.length+returned,bytes:Buffer.byteLength(encoded)}};
}
