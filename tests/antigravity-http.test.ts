import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { ANTIGRAVITY_REQUEST_HEADER, type AntigravityAction, type AntigravityStatus } from "../src/core/contracts/antigravity.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "lh-antigravity-http-test-"));
process.env.LH_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const { antigravityResponse } = await import("../src/server/antigravity/http.ts");

const origin = "http://localhost:3000";
const status: AntigravityStatus = {
	enabled: false, platformSupported: true,
	runtime: { state: "not-installed", version: null, latestVersion: null },
	account: { state: "unknown", tier: null },
	models: [], modelsUpdatedAt: null,
};

function request(method: "GET" | "POST", headers: Record<string, string> = {}, action: unknown = "install") {
	return new Request(`${origin}/api/antigravity`, {
		method, headers: { [ANTIGRAVITY_REQUEST_HEADER]: "1", ...headers },
		...(method === "POST" ? { body: JSON.stringify({ action }) } : {}),
	});
}

const forbiddenDeps = {
	enabled: () => assert.fail("must not check opt-in"),
	readStatus: () => assert.fail("must not read status"),
	runAction: () => assert.fail("must not dispatch an action"),
};

for (const method of ["GET", "POST"] as const) {
	for (const headers of [
		{ origin: "https://attacker.invalid" },
		{ origin: "null" },
		{ "sec-fetch-site": "cross-site", origin },
		{ [ANTIGRAVITY_REQUEST_HEADER]: "" },
		{ origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" },
	] as Record<string, string>[]) test(`unsafe Antigravity ${method} ${JSON.stringify(headers)} is rejected`, async () => {
		const response = await antigravityResponse(request(method, headers), forbiddenDeps);
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	});
}

test("a same-origin GET can read disabled status with no cache", async () => {
	const response = await antigravityResponse(request("GET", { origin, "sec-fetch-site": "same-origin" }), {
		...forbiddenDeps, readStatus: () => status,
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), status);
});

test("disabled settings and unsupported commands never dispatch an action", async () => {
	const disabled = await antigravityResponse(request("POST", { origin }), { ...forbiddenDeps, enabled: () => false });
	assert.equal(disabled.status, 403);
	for (const action of ["sign-out", {}, null]) {
		const unsupported = await antigravityResponse(request("POST", { origin }, action), { ...forbiddenDeps, enabled: () => true });
		assert.equal(unsupported.status, 400);
	}
});

for (const [action, code] of [
	["install", 202], ["update", 202], ["sign-in", 202], ["remove", 200], ["refresh", 200],
] as const) test(`same-origin ${action} dispatches once and returns ${code}`, async () => {
	const calls: AntigravityAction[] = [];
	const response = await antigravityResponse(request("POST", { origin }, action), {
		...forbiddenDeps,
		enabled: () => true,
		runAction: (action) => {
			calls.push(action);
			return { ...status, enabled: true };
		},
	});
	assert.deepEqual(calls, [action]);
	assert.equal(response.status, code);
	assert.equal(response.headers.get("cache-control"), "no-store");
});
