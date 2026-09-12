// Cryptographic fixture checks, NOT full protocol conformance.
// Run with Node 24. Supply the exact installed nostr-tools/pure module path.
import {readFileSync} from 'node:fs';
import {createPublicKey, verify, createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
if (!process.env.NOSTR_PURE_MODULE) throw Error('Set NOSTR_PURE_MODULE to nostr-tools 2.7.2 lib/esm/pure.js');
const {verifyEvent, getEventHash} = await import(pathToFileURL(process.env.NOSTR_PURE_MODULE));
const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };
const fresh = x => JSON.parse(JSON.stringify(x)); // avoid verification cache on mutable objects
const bytes = b => Buffer.from(JSON.stringify(['ans-v2',b.id,b.name,b.subject,b.issuer,b.issuedAt,b.expiresAt]));
const valid = b => verify(null,bytes(b),createPublicKey(b.issuer),Buffer.from(b.signature,'base64'));
check('ANS binding signature',()=>assert.equal(valid(v.binding),true));
check('ANS changed name signature rejection',()=>assert.equal(valid({...v.binding,name:'attacker'}),false));
check('ANS signed serialization digest',()=>assert.equal(createHash('sha256').update(bytes(v.binding)).digest('hex'),v.bindingDigest));
check('Nostr HTTP signature and ID',()=>{assert.equal(verifyEvent(fresh(v.http)),true);assert.equal(getEventHash(v.http),v.http.id);});
check('Nostr URL tamper',()=>{const e=fresh(v.http);e.tags[0][1]+='?changed=1';assert.equal(verifyEvent(e),false);});
check('Nostr method tamper',()=>{const e=fresh(v.http);e.tags[1][1]='DELETE';assert.equal(verifyEvent(e),false);});
check('HTTP body digest',()=>assert.equal(v.http.tags.find(t=>t[0]==='payload')[1],createHash('sha256').update(v.httpBody).digest('hex')));
check('HTTP changed body digest differs',()=>assert.notEqual(v.http.tags.find(t=>t[0]==='payload')[1],createHash('sha256').update(v.httpBody+' ').digest('hex')));
check('Machine message signature',()=>assert.equal(verifyEvent(fresh(v.message)),true));
check('Machine message content tamper',()=>{const e=fresh(v.message);e.content+=' ';assert.equal(verifyEvent(e),false);});
check('Subject dual proof',()=>{const p=JSON.parse(v.identity.content).payload;const data=Buffer.from(JSON.stringify(['ans-nostr-binding-v1',p.binding.id,p.nostrPubkey,p.audience,p.notBefore,p.expiresAt]));assert.equal(verify(null,data,createPublicKey(p.binding.subject),Buffer.from(p.subjectProof,'base64')),true);});
check('Outer identity proof',()=>assert.equal(verifyEvent(fresh(v.identity)),true));
console.log(JSON.stringify({checks, scope:'cryptographic fixtures only', fullConformance:false}));
