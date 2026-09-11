/** Local deterministic HTTP acceptance test. Never contacts a production model or runtime. */
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";

const fixture = http.createServer((request, response) => {
	response.setHeader("Content-Type", "application/json");
	if (request.url === "/v1/models") {
		response.end(
			JSON.stringify({
				data: [
					{ id: "validation-fixture", description: "Local acceptance fixture. No inference." },
				],
			})
		);
	} else {
		response.writeHead(503);
		response.end(JSON.stringify({ error: "No inference in acceptance fixtures" }));
	}
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const modelPort = fixture.address().port;
const reserve = http.createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const appPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${appPort}`;
// Use a minimal environment: do not inherit operator/provider credentials or runtime URLs.
const app = spawn(process.execPath, ["build/index.js"], {
	env: {
		PATH: process.env.PATH,
		NODE_ENV: "production",
		HOST: "127.0.0.1",
		PORT: String(appPort),
		ORIGIN: origin,
		OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
		COOKIE_NAME: "workspace-smoke",
		PUBLIC_APP_NAME: "RuFlo",
		PUBLIC_APP_ASSETS: "chatui",
		ALLOW_INSECURE_COOKIES: "true",
		RVF_DB_PATH: `/tmp/ruflo-workspace-smoke-${process.pid}`,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
app.stdout.on("data", (chunk) => {
	output = (output + chunk).slice(-12000);
});
app.stderr.on("data", (chunk) => {
	output = (output + chunk).slice(-12000);
});
let checks = 0;
try {
	const deadline = Date.now() + 20000;
	for (;;) {
		if (app.exitCode !== null) throw new Error(`App exited ${app.exitCode}: ${output}`);
		try {
			const response = await fetch(`${origin}/healthcheck`);
			if (response.ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error(`App did not become ready: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	for (const [route, marker] of [
		["/workspace", "Intent into action."],
		["/workspace?view=tools", "Find the right tool."],
		["/workspace?view=runtimes", "Every connection has evidence."],
		["/", "What will you build next?"],
		["/models", "validation-fixture"],
	]) {
		const response = await fetch(origin + route);
		const html = await response.text();
		assert.equal(response.status, 200, `${route}: ${html.slice(0, 300)}`);
		assert.ok(html.includes(marker), `${route}: missing ${marker}`);
		checks++;
	}
	const denied = await fetch(`${origin}/api/workspace`);
	assert.ok([401, 403].includes(denied.status));
	checks++;
	console.log(
		JSON.stringify({
			suite: "workspace-http-smoke",
			checks,
			passed: true,
			fixture: "local model list only",
			liveIntegrationsTested: false,
		})
	);
} finally {
	app.kill("SIGTERM");
	await Promise.race([once(app, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
	if (app.exitCode === null) app.kill("SIGKILL");
	fixture.closeAllConnections();
	await new Promise((resolve) => fixture.close(resolve));
}
