import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAntigravitySettingsBody, SETTINGS_SECTIONS } from "../src/server/settings-body.ts";

test("Antigravity is an explicit, section-scoped opt-in", () => {
	assert.equal(SETTINGS_SECTIONS.antigravity, parseAntigravitySettingsBody);
	assert.deepEqual(parseAntigravitySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
		assert.equal(parseAntigravitySettingsBody(raw).ok, false);
	}
});

test("stored Antigravity settings preserve explicit booleans and drop invalid fields", () => {
	assert.equal(sanitizeUserSettings({ version: 1 })?.antigravity, undefined);
	assert.deepEqual(sanitizeUserSettings({
		version: 1, antigravity: { enabled: true, ignored: true }, claudeCode: { enabled: false },
	}), { version: 1, antigravity: { enabled: true }, claudeCode: { enabled: false } });
	assert.deepEqual(sanitizeUserSettings({ version: 1, antigravity: { enabled: false } })?.antigravity, { enabled: false });
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
		assert.deepEqual(sanitizeUserSettings({ version: 1, antigravity: raw })?.antigravity, {});
	}
});
