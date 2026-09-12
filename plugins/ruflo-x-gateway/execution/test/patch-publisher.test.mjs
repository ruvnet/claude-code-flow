import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPatchAdapter } from '../src/patch-adapter.mjs';
import { createDeclarativeSandbox } from '../src/patch-sandbox.mjs';
import { createPatchPublisher, createGitHubRestClient } from '../src/patch-publisher.mjs';
const policy = { commands: [{ argv: ['json-equals', 'value.json', 'answer', '42'] }] };
const patch = 'diff --git a/value.json b/value.json\n--- a/value.json\n+++ b/value.json\n@@ -1 +1 @@\n-{"answer":41}\n+{"answer":42}\n';
async function fixture(t) {
 const dir = await mkdtemp(join(tmpdir(), 'publisher-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
 const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
 git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','test'); await writeFile(join(dir,'value.json'),'{"answer":41}\n'); git('add','.'); git('commit','-m','base');
 const baseSha = git('rev-parse','HEAD');
 const adapter = createPatchAdapter({ repositories: { 'test/repo': dir } }), sandbox = createDeclarativeSandbox();
 const artifact = await adapter.proposePatch({ repository:'test/repo',baseSha,issue:{reference:'#1',text:'fix'},policy,propose:async()=>patch,sandbox });
 const expected = { repository:'test/repo',baseSha,issueReference:artifact.issueReference,issueDigest:artifact.issueDigest };
 const refs = new Map([['main',baseSha]]), commits = new Map([[baseSha,{tree:git('rev-parse','HEAD^{tree}'),parents:[],message:'base'}]]), prs = [], calls = [];
 const github = {
  async getRef(repo,branch){calls.push('getRef'); return refs.get(branch)??null;},
  async getCommit(repo,sha){return commits.get(sha);},
  async createBlob(repo,content){calls.push('blob');return 'blob-sha';},
  async createTree(){calls.push('tree');return artifact.tree;},
  async createCommit(repo,commit){calls.push('commit');commits.set('new-commit',commit);return 'new-commit';},
  async createRef(repo,branch,sha){calls.push('ref');refs.set(branch,sha);},
  async findPullRequest(){return prs[0]??null;},
  async createPullRequest(repo,data){calls.push('pr');const pr={number:1,url:'https://github.com/test/repo/pull/1',...data};prs.push(pr);return pr;},
 };
 const publisher = createPatchPublisher({repositories:{'test/repo':{baseSha,baseBranch:'main'}},verifyPatch:adapter.verifyPatch,github});
 return { publisher, input:{artifact,expected,policy,sandbox,files:{'value.json':{content:'{"answer":42}\n',mode:'100644'}},title:'Fix answer'},github,refs,commits,calls };
}
test('verified fixture publishes draft PR once and reuses deterministic branch',async t=>{
 const f=await fixture(t); const first=await f.publisher.publishVerifiedPatch(f.input);assert.equal(first.draft,true);assert.equal(first.reused,false);
 const again=await f.publisher.publishVerifiedPatch(f.input);assert.equal(again.reused,true);assert.equal(first.branch,again.branch);assert.equal(f.calls.filter(x=>x==='pr').length,1);assert.equal(f.calls.filter(x=>x==='ref').length,1);
});
test('wrong task binding and content rejected before remote writes',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.publisher.publishVerifiedPatch({...f.input,expected:{...f.input.expected,issueReference:'#2'}}),/expected task/);
 assert.equal(f.calls.length,0);
 await assert.rejects(f.publisher.publishVerifiedPatch({...f.input,files:{'value.json':{content:'wrong',mode:'100644'}}}),/content mismatch/);assert.equal(f.calls.length,0);
});
test('base drift and mismatching tree never publish refs',async t=>{
 const f=await fixture(t);f.refs.set('main','advanced');await assert.rejects(f.publisher.publishVerifiedPatch(f.input),/advanced/);assert.ok(!f.calls.includes('ref'));
 f.refs.set('main',f.input.artifact.baseSha);f.github.createTree=async()=> 'wrong-tree';await assert.rejects(f.publisher.publishVerifiedPatch(f.input),/verified tree/);assert.ok(!f.calls.includes('ref'));
});
test('existing branch conflict cannot be overwritten',async t=>{
 const f=await fixture(t);const result=await f.publisher.publishVerifiedPatch(f.input);f.commits.set(result.commit,{tree:'bad',parents:[f.input.artifact.baseSha],message:'bad'});
 await assert.rejects(f.publisher.publishVerifiedPatch(f.input),/branch conflicts/);assert.equal(f.calls.filter(x=>x==='ref').length,1);
});
test('GitHub REST client keeps token in header and fixes endpoint/redirect policy',async()=>{
 const calls=[];const client=createGitHubRestClient({token:'private-test-token',fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({sha:'blob'})};}});
 assert.equal(await client.createBlob('test/repo','content'),'blob');const {url,options}=calls[0];assert.equal(url,'https://api.github.com/repos/test/repo/git/blobs');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer private-test-token');assert.ok(!options.body.includes('private-test-token'));
 await assert.rejects(client.createBlob('../attacker/repo','content'),/Invalid repository/);
});
