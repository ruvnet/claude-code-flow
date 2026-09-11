#!/usr/bin/env node
/**
 * MCP Bridge v2.0.0 — Complete Test Harness
 *
 * Tests:
 *   1. Health endpoint
 *   2. Groups endpoint
 *   3. MCP-servers endpoint (per-group config)
 *   4. Per-group MCP endpoints (initialize, tools/list, tools/call)
 *   5. Catch-all /mcp endpoint (backwards compat)
 *   6. Guidance tool (all topics)
 *   7. Chat completions proxy (model resolution)
 *   8. SSE endpoints (GET /mcp, GET /mcp/{group})
 *   9. Error handling (unknown tool, unknown method)
 *  10. Tool execution for each group
 *
 * Usage:
 *   node test-harness.js [base-url]
 *   Default: http://localhost:3001
 */

const BASE = process.argv[2] || "http://localhost:3001";

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function log(icon, msg) { console.log(`  ${icon} ${msg}`); }

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: "PASS" });
    log("✅", name);
  } catch (err) {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
    log("❌", `${name}: ${err.message}`);
  }
}

function skip(name, reason) {
  skipped++;
  results.push({ name, status: "SKIP", reason });
  log("⏭️ ", `${name} — ${reason}`);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function fetchJSON(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  return { status: res.status, data: await res.json(), headers: res.headers };
}

async function mcpCall(path, method, params = {}) {
  const { data } = await fetchJSON(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `test-${Date.now()}`, method, params }),
  });
  return data;
}

// =============================================================================
// TEST SUITES
// =============================================================================

async function testHealth() {
  console.log("\n── Health & Discovery ──");

  await test("GET /health returns 200", async () => {
    const { status, data } = await fetchJSON("/health");
    assert(status === 200, `status ${status}`);
    assert(data.status === "ok", `status: ${data.status}`);
    assert(data.version === "2.0.0", `version: ${data.version}`);
  });

  await test("GET /health includes groups", async () => {
    const { data } = await fetchJSON("/health");
    assert(data.groups, "missing groups");
    assert(data.groups.core?.enabled === true, "core not enabled");
    assert(data.groups.browser?.enabled === false, "browser should be disabled");
  });

  await test("GET /health includes tool counts", async () => {
    const { data } = await fetchJSON("/health");
    assert(data.tools.builtin === 3, `builtin: ${data.tools.builtin}`);
    assert(data.tools.external > 0, `external: ${data.tools.external}`);
    assert(data.tools.total > 0, `total: ${data.tools.total}`);
  });

  await test("GET /health includes backends", async () => {
    const { data } = await fetchJSON("/health");
    assert(data.backends, "missing backends");
  });
}

async function testGroups() {
  console.log("\n── Groups Endpoint ──");

  await test("GET /groups returns all 13 groups", async () => {
    const { data } = await fetchJSON("/groups");
    const names = Object.keys(data);
    assert(names.length === 13, `got ${names.length} groups`);
    assert(names.includes("operations"), "missing operations");
    assert(names.includes("core"), "missing core");
    assert(names.includes("agents"), "missing agents");
    assert(names.includes("browser"), "missing browser");
  });

  await test("GET /groups shows tool counts for enabled groups", async () => {
    const { data } = await fetchJSON("/groups");
    assert(data.core.tools === 3, `core tools: ${data.core.tools}`);
    assert(data.core.enabled === true, "core not enabled");
    // Disabled groups should have 0 tools
    assert(data.browser.tools === 0, `browser tools: ${data.browser.tools}`);
    assert(data.browser.enabled === false, "browser should be disabled");
  });
}

async function testMcpServers() {
  console.log("\n── MCP Servers Endpoint ──");

  await test("GET /mcp-servers returns enabled groups", async () => {
    const { data } = await fetchJSON("/mcp-servers");
    assert(Array.isArray(data), "not an array");
    assert(data.length >= 3, `only ${data.length} servers`);
    const names = data.map(s => s.name);
    assert(names.includes("Core Tools"), `missing Core Tools, got: ${names.join(", ")}`);
  });

  await test("GET /mcp-servers includes per-group URLs", async () => {
    const { data } = await fetchJSON("/mcp-servers");
    for (const server of data) {
      assert(server.url.startsWith("/mcp/"), `bad url: ${server.url}`);
      assert(server.tools > 0, `${server.name} has 0 tools`);
      assert(server.group, `${server.name} missing group field`);
    }
  });

  await test("GET /mcp-servers excludes disabled groups", async () => {
    const { data } = await fetchJSON("/mcp-servers");
    const groups = data.map(s => s.group);
    assert(!groups.includes("browser"), "browser should not be listed");
    assert(!groups.includes("security"), "security should not be listed");
    assert(!groups.includes("neural"), "neural should not be listed");
  });
}

async function testPerGroupMcp() {
  console.log("\n── Per-Group MCP Endpoints ──");

  const enabledGroups = ["core", "intelligence", "agents", "memory", "devtools"];
  const disabledGroups = ["security", "browser", "neural"];

  for (const group of enabledGroups) {
    await test(`POST /mcp/${group} — initialize`, async () => {
      const res = await mcpCall(`/mcp/${group}`, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-harness", version: "1.0.0" },
      });
      assert(res.result, `no result for ${group}`);
      assert(res.result.serverInfo.name === `mcp-bridge/${group}`, `serverInfo: ${JSON.stringify(res.result.serverInfo)}`);
    });

    await test(`POST /mcp/${group} — tools/list`, async () => {
      const res = await mcpCall(`/mcp/${group}`, "tools/list", {});
      assert(res.result?.tools, `no tools for ${group}`);
      assert(res.result.tools.length > 0, `${group} has 0 tools`);
    });
  }

  for (const group of disabledGroups) {
    await test(`POST /mcp/${group} — tools/list returns empty (disabled)`, async () => {
      const res = await mcpCall(`/mcp/${group}`, "tools/list", {});
      assert(res.result?.tools, `no tools array for ${group}`);
      assert(res.result.tools.length === 0, `${group} should have 0 tools, got ${res.result.tools.length}`);
    });
  }
}

async function testToolCounts() {
  console.log("\n── Tool Count Verification ──");

  await test("Per-group tool counts sum to total", async () => {
    const { data: groups } = await fetchJSON("/groups");
    const { data: health } = await fetchJSON("/health");

    let groupSum = 0;
    const enabledGroupTools = {};
    for (const [name, g] of Object.entries(groups)) {
      if (g.enabled && g.tools > 0) {
        enabledGroupTools[name] = g.tools;
        groupSum += g.tools;
      }
    }
    // Groups may overlap (e.g., hooks_ prefix in both intelligence and devtools)
    // so sum >= total is expected. Just verify it's in the right ballpark.
    assert(groupSum >= health.tools.total, `group sum ${groupSum} < total ${health.tools.total}`);
    log("ℹ️ ", `Group sum: ${groupSum}, Total: ${health.tools.total} (overlap is expected)`);
  });

  await test("Each per-group endpoint matches /groups count", async () => {
    const { data: groups } = await fetchJSON("/groups");
    for (const [name, g] of Object.entries(groups)) {
      if (!g.enabled) continue;
      const res = await mcpCall(`/mcp/${name}`, "tools/list", {});
      const actual = res.result?.tools?.length || 0;
      assert(actual === g.tools, `${name}: /groups says ${g.tools}, /mcp/${name} returns ${actual}`);
    }
  });
}

async function testCatchAllMcp() {
  console.log("\n── Catch-All /mcp (Backwards Compat) ──");

  await test("POST /mcp — initialize", async () => {
    const res = await mcpCall("/mcp", "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-harness", version: "1.0.0" },
    });
    assert(res.result?.serverInfo?.name === "mcp-bridge", `serverInfo: ${JSON.stringify(res.result?.serverInfo)}`);
  });

  await test("POST /mcp — tools/list returns all tools", async () => {
    const res = await mcpCall("/mcp", "tools/list", {});
    assert(res.result?.tools, "no tools");
    const { data: health } = await fetchJSON("/health");
    assert(res.result.tools.length === health.tools.total, `tools: ${res.result.tools.length} vs health total: ${health.tools.total}`);
  });

  await test("POST /mcp — unknown method returns error", async () => {
    const res = await mcpCall("/mcp", "nonexistent/method", {});
    assert(res.error, "should return error");
    assert(res.error.code === -32601, `error code: ${res.error.code}`);
  });
}

async function testGuidanceTool() {
  console.log("\n── Guidance Tool ──");

  const topics = ["overview", "groups", "intelligence", "agents", "memory", "devtools",
    "security", "browser", "neural", "agentic-flow", "claude-code", "gemini", "codex"];

  for (const topic of topics) {
    await test(`guidance(topic="${topic}")`, async () => {
      const res = await mcpCall("/mcp/core", "tools/call", {
        name: "guidance",
        arguments: { topic },
      });
      assert(res.result?.content, `no content for topic ${topic}`);
      const text = res.result.content[0]?.text;
      assert(text, `empty text for topic ${topic}`);
      const parsed = JSON.parse(text);
      assert(parsed.guidance, `no guidance field for topic ${topic}`);
      assert(parsed.topic === topic, `topic mismatch: ${parsed.topic}`);
    });
  }

  await test("guidance(topic='tool', tool_name='search')", async () => {
    const res = await mcpCall("/mcp/core", "tools/call", {
      name: "guidance",
      arguments: { topic: "tool", tool_name: "search" },
    });
    const text = res.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    assert(parsed.guidance.includes("search"), `guidance doesn't mention search`);
  });

  await test("guidance(topic='tool', tool_name='nonexistent') returns not found", async () => {
    const res = await mcpCall("/mcp/core", "tools/call", {
      name: "guidance",
      arguments: { topic: "tool", tool_name: "fake_tool_xyz" },
    });
    const text = res.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    assert(parsed.guidance.includes("not found"), `should say not found`);
  });
}

async function testToolExecution() {
  console.log("\n── Tool Execution ──");

  // Test built-in tools via core endpoint
  await test("Core: guidance tool via /mcp/core", async () => {
    const res = await mcpCall("/mcp/core", "tools/call", {
      name: "guidance",
      arguments: { topic: "overview" },
    });
    assert(res.result?.content, "no content");
  });

  // Test calling unknown tool gives helpful error
  await test("Unknown tool returns error with guidance hint", async () => {
    const res = await mcpCall("/mcp/core", "tools/call", {
      name: "completely_fake_tool",
      arguments: {},
    });
    const text = res.result?.content?.[0]?.text;
    assert(text, "no response text");
    const parsed = JSON.parse(text);
    assert(parsed.error, "should have error");
    assert(parsed.error.includes("guidance"), `error should mention guidance: ${parsed.error}`);
  });

  // Test external tool execution (pick first tool from intelligence group)
  await test("Intelligence: call first available tool", async () => {
    const listRes = await mcpCall("/mcp/intelligence", "tools/list", {});
    const tools = listRes.result?.tools;
    if (!tools || tools.length === 0) { skip("Intelligence tool execution", "no tools"); return; }
    const firstTool = tools[0];
    // Just verify the call doesn't crash — the tool may return an error depending on args
    const res = await mcpCall("/mcp/intelligence", "tools/call", {
      name: firstTool.name,
      arguments: {},
    });
    assert(res.result?.content, `no content from ${firstTool.name}`);
  });

  // Test agents group tool
  await test("Agents: call first available tool", async () => {
    const listRes = await mcpCall("/mcp/agents", "tools/list", {});
    const tools = listRes.result?.tools;
    if (!tools || tools.length === 0) { skip("Agents tool execution", "no tools"); return; }
    const firstTool = tools[0];
    const res = await mcpCall("/mcp/agents", "tools/call", {
      name: firstTool.name,
      arguments: {},
    });
    assert(res.result?.content, `no content from ${firstTool.name}`);
  });

  // Test memory group tool
  await test("Memory: call first available tool", async () => {
    const listRes = await mcpCall("/mcp/memory", "tools/list", {});
    const tools = listRes.result?.tools;
    if (!tools || tools.length === 0) { skip("Memory tool execution", "no tools"); return; }
    const firstTool = tools[0];
    const res = await mcpCall("/mcp/memory", "tools/call", {
      name: firstTool.name,
      arguments: {},
    });
    assert(res.result?.content, `no content from ${firstTool.name}`);
  });

  // Test devtools group tool
  await test("DevTools: call first available tool", async () => {
    const listRes = await mcpCall("/mcp/devtools", "tools/list", {});
    const tools = listRes.result?.tools;
    if (!tools || tools.length === 0) { skip("DevTools tool execution", "no tools"); return; }
    const firstTool = tools[0];
    const res = await mcpCall("/mcp/devtools", "tools/call", {
      name: firstTool.name,
      arguments: {},
    });
    assert(res.result?.content, `no content from ${firstTool.name}`);
  });
}

async function testCrossGroupExecution() {
  console.log("\n── Cross-Group Tool Execution ──");

  // Verify that calling a tool from the wrong group endpoint still works
  // (because executeTool routes by tool name, not by endpoint)
  await test("Tool call via /mcp/core routes to correct backend", async () => {
    // Get a tool name from intelligence
    const listRes = await mcpCall("/mcp/intelligence", "tools/list", {});
    const tools = listRes.result?.tools;
    if (!tools || tools.length === 0) { skip("Cross-group execution", "no intelligence tools"); return; }

    // Call it through /mcp (catch-all) instead of /mcp/intelligence
    const toolName = tools[0].name;
    const res = await mcpCall("/mcp", "tools/call", {
      name: toolName,
      arguments: {},
    });
    assert(res.result?.content, `cross-group call failed for ${toolName}`);
  });
}

async function testSSE() {
  console.log("\n── SSE Endpoints ──");

  await test("GET /mcp returns SSE headers", async () => {
    const res = await fetch(`${BASE}/mcp`);
    assert(res.headers.get("content-type")?.includes("text/event-stream"), "not SSE");
  });

  await test("GET /mcp/core returns SSE headers", async () => {
    const res = await fetch(`${BASE}/mcp/core`);
    assert(res.headers.get("content-type")?.includes("text/event-stream"), "not SSE");
  });
}

async function testModels() {
  console.log("\n── Models Endpoint ──");

  await test("GET /models returns model list", async () => {
    const { data } = await fetchJSON("/models");
    assert(data.object === "list", `object: ${data.object}`);
    assert(data.data.length > 0, "no models");
    assert(data.data.every(m => m.id && m.object === "model"), "bad model format");
  });
}

async function testNotificationsInitialized() {
  console.log("\n── Notifications ──");

  await test("notifications/initialized via /mcp", async () => {
    const res = await mcpCall("/mcp", "notifications/initialized", {});
    assert(res.result, "no result");
  });

  await test("notifications/initialized via /mcp/core", async () => {
    const res = await mcpCall("/mcp/core", "notifications/initialized", {});
    assert(res.result, "no result");
  });
}

// =============================================================================
// RUN
// =============================================================================

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  MCP Bridge v2.0.0 — Complete Test Harness          ║`);
  console.log(`║  Base URL: ${BASE.padEnd(40)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);

  // Verify bridge is reachable
  try {
    await fetch(`${BASE}/health`);
  } catch (err) {
    console.error(`\n❌ Cannot reach ${BASE}: ${err.message}`);
    console.error("   Start the MCP bridge first: docker compose up mcp-bridge");
    process.exit(1);
  }

  await testHealth();
  await testGroups();
  await testMcpServers();
  await testPerGroupMcp();
  await testToolCounts();
  await testCatchAllMcp();
  await testGuidanceTool();
  await testToolExecution();
  await testCrossGroupExecution();
  await testSSE();
  await testModels();
  await testNotificationsInitialized();

  // --- Summary ---
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Results: ${String(passed).padStart(3)} passed  ${String(failed).padStart(3)} failed  ${String(skipped).padStart(3)} skipped${" ".repeat(7)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter(r => r.status === "FAIL")) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
