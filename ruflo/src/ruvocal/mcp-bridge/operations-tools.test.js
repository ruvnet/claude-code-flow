import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS_TOOL_NAMES, createOperationsGroup, toolMatchesGroup, projectBackendTools, backendInvocation } from "./operations-tools.js";

const bridgeRoot = dirname(fileURLToPath(import.meta.url));
const fixtureNames = [
  ...OPERATIONS_TOOL_NAMES.filter(name => name !== "metaharness_flywheel_status"),
  "metaharness_flywheel", "metaharness_evolve", "policy_approve", "managed_agent_terminate",
  "autopilot_enable", "ruvllm_generate", "mcp_status_evil", "agent_list",
];
const fixtureTools = fixtureNames.map(name => ({
  name, _originalName: name, _backend: "ruflo", inputSchema: { type: "object" },
}));

test("operations require the exact operator opt-in and match only seven names", () => {
  const projected = projectBackendTools(fixtureTools, "ruflo");
  for (const value of [undefined, "false", "1", "TRUE", "true "]) {
    assert.equal(projected.filter(tool => toolMatchesGroup(tool, createOperationsGroup({ MCP_GROUP_OPERATIONS: value }))).length, 0);
  }
  const group = createOperationsGroup({ MCP_GROUP_OPERATIONS: "true" });
  assert.deepEqual(projected.filter(tool => toolMatchesGroup(tool, group)).map(tool => tool._originalName).sort(), [...OPERATIONS_TOOL_NAMES].sort());
  assert.equal(toolMatchesGroup({ ...projected[0], _backend: "untrusted" }, group), false);
});

test("exact-name selection never becomes wildcard and preserves legacy prefixes", () => {
  const tool = fixtureTools[0];
  assert.equal(toolMatchesGroup(tool, { enabled: true, source: "ruflo", exactNames: [] }), false);
  assert.equal(toolMatchesGroup(tool, { enabled: true, source: "ruflo", prefixes: [] }), false);
  assert.equal(toolMatchesGroup(tool, { enabled: true, source: "ruflo" }), true);
  assert.equal(toolMatchesGroup(tool, { enabled: true, source: "ruflo", prefixes: ["mcp_"] }), true);
});

test("flywheel wrapper requires upstream discovery and ignores forged alias metadata", () => {
  assert.equal(projectBackendTools([], "ruflo").length, 0);
  assert.equal(projectBackendTools([{ ...fixtureTools[0], _originalName: "metaharness_flywheel_status" }], "ruflo").length, 0);
  const alias = projectBackendTools(fixtureTools, "ruflo").find(tool => tool._originalName === "metaharness_flywheel_status");
  assert.deepEqual(alias.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.deepEqual(backendInvocation(alias, {}), { name: "metaharness_flywheel", arguments: { operation: "status" } });
  for (const args of [null, [], "status", { operation: "status" }, { operation: "run" }, { operation: "promote", confirm: true }, { projectRoot: "/tmp/other" }, { publicKeyPath: "key.pem" }, { approvalIds: ["approval"] }]) {
    assert.throws(() => backendInvocation(alias, args));
  }
});

test("other operations retain bounded read inputs", () => {
  const tool = name => fixtureTools.find(item => item._originalName === name);
  assert.deepEqual(backendInvocation(tool("managed_agent_list"), { limit: 20 }).arguments, { limit: 20 });
  for (const limit of [0, 201, 1.2, Infinity, "10"]) assert.throws(() => backendInvocation(tool("managed_agent_list"), { limit }));
  assert.deepEqual(backendInvocation(tool("managed_agent_status"), { sessionId: "session_1" }).arguments, { sessionId: "session_1" });
  for (const args of [{}, { sessionId: " " }, { sessionId: "x".repeat(257) }, { sessionId: "session_1", terminate: true }]) assert.throws(() => backendInvocation(tool("managed_agent_status"), args));
  for (const name of ["mcp_status", "autopilot_status", "policy_status", "ruvllm_status"]) {
    assert.throws(() => backendInvocation(tool(name), { operation: "run" }));
    assert.deepEqual(backendInvocation(tool(name), {}).arguments, {});
  }
});

async function startFixture(t, operationsEnabled) {
  const directory = await mkdtemp(join(tmpdir(), "ruflo-operations-test-"));
  const command = join(directory, "npx");
  const logPath = join(directory, "calls.jsonl");
  const script = `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const names = ${JSON.stringify(fixtureNames)};
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  let result = {};
  if (m.method === 'initialize') result = {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  if (m.method === 'tools/list') result = {tools:names.map(name=>({name,inputSchema:{type:'object'}}))};
  if (m.method === 'tools/call') {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(m.params)+'\\n');
    result = {observed:m.params};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`;
  await writeFile(command, script);
  await chmod(command, 0o755);
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    PORT: "0", MCP_BIND_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "local-test-token",
    MCP_GROUP_OPERATIONS: operationsEnabled ? "true" : "false",
  };
  for (const group of ["INTELLIGENCE", "AGENTS", "MEMORY", "DEVTOOLS", "SECURITY", "BROWSER", "NEURAL", "AGENTIC_FLOW", "CLAUDE_CODE", "GEMINI", "CODEX"]) env[`MCP_GROUP_${group}`] = "false";
  const child = spawn(process.execPath, [join(bridgeRoot, "index.js")], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const until = Date.now() + 10_000;
  let port;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Bridge exited: ${output}`);
    port = /on port (\d+)/.exec(output)?.[1];
    if (port && (!operationsEnabled || output.includes("tools loaded"))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(port, `Bridge did not listen: ${output}`);
  if (operationsEnabled) assert.match(output, /tools loaded/);
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer local-test-token", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return response.json();
  };
  return {
    request,
    rpc: (path, method, params = {}) => request(path, { jsonrpc: "2.0", id: 1, method, params }),
    calls: async () => {
      try { return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

test("HTTP endpoints hide operations by default and reject direct calls", { timeout: 15000 }, async t => {
  const bridge = await startFixture(t, false);
  assert.equal((await bridge.request("/groups")).operations.enabled, false);
  assert.equal((await bridge.request("/mcp-servers")).some(server => server.group === "operations"), false);
  assert.deepEqual((await bridge.rpc("/mcp/operations", "tools/list")).result.tools, []);
  assert.equal((await bridge.rpc("/mcp", "tools/list")).result.tools.some(tool => tool.name.startsWith("ruflo__")), false);
  for (const endpoint of ["/mcp", "/mcp/operations", "/mcp/core"]) {
    const result = await bridge.rpc(endpoint, "tools/call", { name: "ruflo__policy_status", arguments: {} });
    assert.equal(result.result.isError, true);
    assert.equal(JSON.parse(result.result.content[0].text).code, "TOOL_NOT_ALLOWED");
  }
  assert.deepEqual(await bridge.calls(), []);
});

test("HTTP discovery and execution expose only bounded read operations", { timeout: 15000 }, async t => {
  const bridge = await startFixture(t, true);
  const tools = (await bridge.rpc("/mcp/operations", "tools/list")).result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), OPERATIONS_TOOL_NAMES.map(name => `ruflo__${name}`).sort());
  assert.equal((await bridge.request("/groups")).operations.tools, 7);
  assert.equal((await bridge.request("/mcp-servers")).find(server => server.group === "operations").tools, 7);
  assert.equal((await bridge.rpc("/mcp", "tools/list")).result.tools.filter(tool => tool.name.startsWith("ruflo__")).length, 7);
  for (const endpoint of ["/mcp", "/mcp/operations"]) {
    for (const name of ["ruflo__metaharness_flywheel", "ruflo__metaharness_evolve", "ruflo__policy_approve", "ruflo__managed_agent_terminate", "ruflo__autopilot_enable", "ruflo__mcp_status_evil", "metaharness_flywheel_status"]) {
      const result = await bridge.rpc(endpoint, "tools/call", { name, arguments: { operation: "run" } });
      assert.equal(result.result.isError, true, name);
    }
    for (const args of [{ operation: "run" }, { operation: "promote", confirm: true }, { projectRoot: "/tmp/other" }, []]) {
      const result = await bridge.rpc(endpoint, "tools/call", { name: "ruflo__metaharness_flywheel_status", arguments: args });
      assert.equal(JSON.parse(result.result.content[0].text).code, "INVALID_TOOL_ARGUMENTS");
    }
  }
  const outsideGroup = await bridge.rpc("/mcp/core", "tools/call", { name: "ruflo__policy_status", arguments: {} });
  assert.equal(outsideGroup.result.isError, true);
  assert.deepEqual(await bridge.calls(), []);
  for (const endpoint of ["/mcp", "/mcp/operations"]) {
    const result = await bridge.rpc(endpoint, "tools/call", { name: "ruflo__metaharness_flywheel_status", arguments: {} });
    assert.equal(result.result.isError, false);
    assert.deepEqual(JSON.parse(result.result.content[0].text).observed, { name: "metaharness_flywheel", arguments: { operation: "status" } });
  }
  assert.deepEqual(await bridge.calls(), [
    { name: "metaharness_flywheel", arguments: { operation: "status" } },
    { name: "metaharness_flywheel", arguments: { operation: "status" } },
  ]);
});
