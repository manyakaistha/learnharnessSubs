import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AcpClosedError, AcpConnection, AcpRequestError, antigravityEnv, catalogFromSession, tierFromMeta, variantModelId } from '../src/agent/antigravity/acp-client.ts';

const fake = fileURLToPath(new URL('./fixtures/antigravity/fake-agy.mjs', import.meta.url));
test('catalog derives ordered supported suffixes and model fallbacks', () => {
 const bases = ['gemini-4-neon', 'claude-opus-5-5', 'gpt-oss-120b-medium'];
 const ids = ['gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low', 'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'];
 const catalog = catalogFromSession({ sessionId: 's', models: { availableModels: ids.map(modelId => ({ modelId })) }, configOptions: [{ id: 'model', options: bases.map(value => ({ value })) }] }, 123, 42);
 assert.deepEqual(catalog.models.map(m => m.thinkingLevels), [['low', 'medium', 'high', 'xhigh'], ['low', 'medium', 'high'], []]); assert.equal(catalog.contextWindow, 123); assert.equal(catalog.updatedAt, 42);
 assert.equal(variantModelId(catalog.models[0]!, 'high'), 'gemini-4-neon-high'); assert.equal(variantModelId(catalog.models[0]!, 'max'), 'gemini-4-neon-medium'); assert.equal(variantModelId({ id: 'x', name: 'x', thinkingLevels: ['high'] }, undefined), 'x-high'); assert.equal(variantModelId(catalog.models[2]!, 'low'), bases[2]);
});
test('tier and environment filtering', () => { assert.equal(tierFromMeta({ _meta: { antigravity: { tier: { name: ' Pro ' } } } }), 'Pro'); assert.equal(tierFromMeta({}), null); assert.equal(tierFromMeta({ _meta: { antigravity: { tier: { name: '  ' } } } }), null); assert.deepEqual(antigravityEnv('/profile', { GEMINI_API_KEY: 'x', google_api_key: 'x', GOOGLE_APPLICATION_CREDENTIALS: 'x', GOOGLE_CLOUD_PROJECT: 'x', GCLOUD_PROJECT: 'x', ELECTRON_RUN_AS_NODE: '1', GEMINI_HOME: 'old', KEEP: 'yes' }), { KEEP: 'yes', GEMINI_HOME: '/profile' }); });
test('ACP peer handles replies, errors, unknown requests, raw output and exit', async t => {
 const dir = mkdtempSync(join(tmpdir(), 'acp-peer-')); const log = join(dir, 'log'); const child = spawn(process.execPath, [fake], { env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_SCRIPT: '[]' }, stdio: 'pipe' }); t.after(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }); const peer = new AcpConnection(child); const raw: string[] = []; peer.onRawLine(line => raw.push(line));
 assert.deepEqual(await peer.request('initialize', {}), { protocolVersion: 1 }); await assert.rejects(peer.request('test/error', {}), (e: unknown) => e instanceof AcpRequestError && e.code === 42 && e.message === 'test error' && (e.data as any).detail === true); assert.equal(await peer.request('test/raw', {}), 'ok'); assert.deepEqual(raw, ['raw output']); await peer.request('test/unknown', {});
 const deadline = Date.now() + 2000; while (!readFileSync(log, 'utf8').includes('-32601')) { assert.ok(Date.now() < deadline); await sleep(10); } const pending = peer.request('never', {}); child.kill(); await assert.rejects(pending, AcpClosedError); await assert.rejects(peer.request('after', {}), AcpClosedError);
});
