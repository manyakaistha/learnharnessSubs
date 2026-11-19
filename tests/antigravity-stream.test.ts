import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { Message, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createAntigravityStreamFunction } from '../src/agent/antigravity/stream.ts';
import { antigravityPiModel } from '../src/agent/antigravity/provider.ts';
import { antigravityBinariesInUse, setAntigravityCatalog } from '../src/agent/antigravity/runtime-source.ts';
import type { SpawnAcp } from '../src/agent/antigravity/acp-client.ts';

const fake = fileURLToPath(new URL('./fixtures/antigravity/fake-agy.mjs', import.meta.url));
const catalogModel = { id: 'gemini-3.8-flash', name: 'Flash', thinkingLevels: ['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[] };
setAntigravityCatalog({ models: [catalogModel], contextWindow: null, updatedAt: 0 });
const model = antigravityPiModel(catalogModel, null);
const hi: Message = { role: 'user', content: 'hi', timestamp: 0 };
const tools = [{ name: 'weather', description: 'Weather', parameters: { type: 'object' as const, properties: { city: { type: 'string' as const } } } }];
const ctx = (messages: Message[] = [hi]) => normalizeContext({ systemPrompt: 'Teach carefully.', messages, tools });
const result = { role: 'toolResult' as const, toolCallId: 'call-1', toolName: 'weather', content: [{ type: 'text' as const, text: 'sunny' }], isError: false, timestamp: 0 };
function setup(t: TestContext, scripts: object[][]) {
 const dir = mkdtempSync(join(tmpdir(), 'fake-agy-test-')); const calls: { child: ReturnType<typeof spawn>; cwd: string; args: string[]; entries: string[]; log: string; sent: string[] }[] = [];
 t.after(() => { for (const call of calls) call.child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
 const spec = { binary: join(dir, 'agy'), profileDir: join(dir, 'profile') };
 const spawnAcp: SpawnAcp = (_binary, args, options) => {
  const log = join(dir, `log-${calls.length}`); const script = scripts[Math.min(calls.length, scripts.length - 1)];
  const entries = readdirSync(options.cwd);
  const child = spawn(process.execPath, [fake, ...args], { cwd: options.cwd, env: { ...options.env, FAKE_AGY_LOG: log, FAKE_AGY_SCRIPT: JSON.stringify(script) }, stdio: 'pipe' });
  const sent: string[] = []; const write = child.stdin.write.bind(child.stdin); child.stdin.write = ((chunk: any, ...rest: any[]) => { sent.push(String(chunk)); return (write as any)(chunk, ...rest); }) as typeof child.stdin.write;
  calls.push({ child, cwd: options.cwd, args, entries, log, sent }); return child;
 };
 return { calls, spec, stream: createAntigravityStreamFunction(() => spec, spawnAcp) };
}
async function collect(stream: ReturnType<ReturnType<typeof createAntigravityStreamFunction>>) { const events = []; for await (const event of stream) events.push(event); return events; }
const logs = (path: string): any[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function cleaned(call: { child: ReturnType<typeof spawn>; cwd: string }, binary: string) { const until = Date.now() + 3000; while (existsSync(call.cwd) || antigravityBinariesInUse().has(binary)) { assert.ok(Date.now() < until, 'cleanup timed out'); await sleep(10); } assert.ok(call.child.exitCode !== null || call.child.signalCode !== null); }
const turn = (stream: ReturnType<typeof createAntigravityStreamFunction>, messages: Message[] = [hi], options: SimpleStreamOptions = {}) => collect(stream(model, ctx(messages), { sessionId: 'test', ...options }));
const done = (events: Awaited<ReturnType<typeof collect>>) => { const e = events.at(-1); assert.ok(e?.type === 'done'); return e.message; };
const permission = { type: 'permission', id: 'call-1', name: 'mcp_learnharness_weather', args: { city: 'Paris', toolSummary: 'look up' } };
const call = { type: 'call', name: 'weather', args: { city: 'Paris' } };

test('text, usage, launch isolation, model and session configuration', async t => {
 const oldGemini = process.env.GEMINI_API_KEY, oldGoogle = process.env.GOOGLE_API_KEY; process.env.GEMINI_API_KEY = 'secret'; process.env.GOOGLE_API_KEY = 'secret'; t.after(() => { if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini; if (oldGoogle === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = oldGoogle; });
 const s = setup(t, [[{ type: 'chunk', text: 'Hello' }, { type: 'usage_update', size: 12345 }, { type: 'reply', usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30, cachedWriteTokens: 5, thoughtTokens: 4 } }]]);
 const events = await turn(s.stream, [hi], { reasoning: 'low' }); const message = done(events);
 assert.deepEqual(events.map(e => e.type), ['start', 'text_start', 'text_delta', 'text_end', 'done']);
 assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }]); assert.deepEqual([message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite, message.usage.totalTokens, message.usage.reasoning], [100, 20, 30, 5, 155, 4]); assert.equal((message as any).cliContextWindow, 12345);
 await cleaned(s.calls[0]!, s.spec.binary); const records = logs(s.calls[0]!.log); const start = records[0]; assert.deepEqual(start.argv, ['acp', '--gemini-dir', s.spec.profileDir, '--app-data-dir', 'antigravity-acp', '--include-default-customizations=false', '--disable-telemetry']); assert.deepEqual(s.calls[0]!.entries, []); assert.equal(start.env.GEMINI_HOME, s.spec.profileDir); assert.equal(start.env.GEMINI_API_KEY, undefined); assert.equal(start.env.GOOGLE_API_KEY, undefined);
 const get = (method: string) => records.find(r => r.message?.method === method).message.params; assert.deepEqual(get('initialize').clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }); assert.equal(get('session/set_model').modelId, 'gemini-3.8-flash-low'); const session = get('session/new'); assert.match(session._meta.antigravity.systemPrompt.append, /LearnHarness[\s\S]*Teach carefully/); assert.equal(session.mcpServers[0].type, 'http'); assert.equal(session.mcpServers[0].name, 'learnharness'); assert.match(session.mcpServers[0].url, /^http:\/\/127\.0\.0\.1:/); assert.match(session.mcpServers[0].headers[0].value, /^Bearer /);
});
test('unsupported reasoning falls back to medium', async t => { const s = setup(t, [[{ type: 'reply' }]]); done(await turn(s.stream, [hi], { reasoning: 'max' })); await cleaned(s.calls[0]!, s.spec.binary); assert.equal(logs(s.calls[0]!.log).find(r => r.message?.method === 'session/set_model').message.params.modelId, 'gemini-3.8-flash-medium'); });
test('text and thought transitions close each block', async t => { const s = setup(t, [[{ type: 'chunk', text: 'a' }, { type: 'chunk', kind: 'thought', text: 'b' }, { type: 'chunk', text: 'c' }, { type: 'reply' }]]); const events = await turn(s.stream); assert.deepEqual(events.map(e => e.type), ['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done']); assert.deepEqual(done(events).content, [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'b' }, { type: 'text', text: 'c' }]); await cleaned(s.calls[0]!, s.spec.binary); });
test('tool admission and result continue on the same process', async t => { const s = setup(t, [[permission, call, { type: 'reply' }]]); const first = done(await turn(s.stream)); assert.equal(first.stopReason, 'toolUse'); assert.deepEqual(first.content, [{ type: 'toolCall', id: 'call-1', name: 'weather', arguments: { city: 'Paris' } }]); const second = done(await turn(s.stream, [hi, first, result])); assert.deepEqual(second.content, [{ type: 'text', text: 'sunny' }]); assert.equal(s.calls.length, 1); await cleaned(s.calls[0]!, s.spec.binary); assert.equal(logs(s.calls[0]!.log).find(r => r.event === 'permission').result.outcome.optionId, 'allow'); });
for (const name of ['read_file', 'mcp_learnharness_unknown']) test(`denies permission for ${name}`, async t => { const s = setup(t, [[{ ...permission, name }, { type: 'reply' }]]); done(await turn(s.stream)); await cleaned(s.calls[0]!, s.spec.binary); assert.equal(logs(s.calls[0]!.log).find(r => r.event === 'permission').result.outcome.optionId, 'deny'); });
test('mismatched MCP arguments produce compatibility error', async t => { const s = setup(t, [[permission, { ...call, args: { city: 'Rome' } }, { type: 'wait' }]]); const events = await turn(s.stream); const e = events.at(-1); assert.ok(e?.type === 'error'); assert.match(e.error.errorMessage ?? '', /Antigravity compatibility error/); await cleaned(s.calls[0]!, s.spec.binary); });
test('abort cancels, kills and cleans up', async t => { const s = setup(t, [[{ type: 'chunk', text: 'ready' }, { type: 'wait' }]]); const controller = new AbortController(); const events = []; for await (const event of s.stream(model, ctx(), { signal: controller.signal })) { events.push(event); if (event.type === 'text_delta') controller.abort(); } const e = events.at(-1); assert.ok(e?.type === 'error'); assert.equal(e.reason, 'aborted'); await cleaned(s.calls[0]!, s.spec.binary); assert.ok(s.calls[0]!.sent.some(line => JSON.parse(line).method === 'session/cancel')); });
test('unavailable runtime reports error', async () => { const events = await collect(createAntigravityStreamFunction(() => null)(model, ctx())); const e = events.at(-1); assert.ok(e?.type === 'error'); assert.match(e.error.errorMessage ?? '', /Antigravity is unavailable/); });
test('unexpected exit reports error and cleans up', async t => { const s = setup(t, [[{ type: 'exit' }]]); const e = (await turn(s.stream)).at(-1); assert.ok(e?.type === 'error'); assert.match(e.error.errorMessage ?? '', /Antigravity stopped/); await cleaned(s.calls[0]!, s.spec.binary); });
test('mismatched continuation kills old process and replays in a fresh one', async t => { const s = setup(t, [[permission, call, { type: 'wait' }], [{ type: 'chunk', text: 'fresh' }, { type: 'reply' }]]); const first = done(await turn(s.stream)); const mismatch = { ...result, toolName: 'different' }; const second = done(await turn(s.stream, [hi, first, mismatch])); assert.equal(second.content[0]?.type, 'text'); assert.equal(s.calls.length, 2); await cleaned(s.calls[0]!, s.spec.binary).catch(async () => { await cleaned(s.calls[1]!, s.spec.binary); await cleaned(s.calls[0]!, s.spec.binary); }); await cleaned(s.calls[1]!, s.spec.binary); const prompt = logs(s.calls[1]!.log).find(r => r.message?.method === 'session/prompt').message.params.prompt; assert.match(JSON.stringify(prompt), /sunny/); });
test('tool batch without session ID releases its process', async t => { const s = setup(t, [[permission, call, { type: 'wait' }]]); const message = done(await turn(s.stream, [hi], { sessionId: undefined })); assert.equal(message.stopReason, 'toolUse'); await cleaned(s.calls[0]!, s.spec.binary); });
