import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const log = (entry) => appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const scriptValue = process.env.FAKE_AGY_SCRIPT || '[]';
const steps = JSON.parse(scriptValue.startsWith('[') ? scriptValue : readFileSync(scriptValue, 'utf8'));
log({ event: 'start', argv: process.argv.slice(2), cwd: process.cwd(), env: { GEMINI_HOME: process.env.GEMINI_HOME, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY } });
let server, nextId = 1000;
const pending = new Map();
function request(method, params) { const id = nextId++; send({ jsonrpc: '2.0', id, method, params }); return new Promise(resolve => pending.set(id, resolve)); }
function update(update) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update } }); }
async function run(id) {
 let client;
 for (const step of steps) {
  if (step.type === 'chunk') update({ sessionUpdate: step.kind === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: step.text } });
  if (step.type === 'usage_update') update({ sessionUpdate: 'usage_update', size: step.size });
  if (step.type === 'permission') { const result = await request('session/request_permission', { sessionId: 'fake-session', toolCall: { toolCallId: step.id, name: step.name, rawInput: step.args }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] }); log({ event: 'permission', result }); }
  if (step.type === 'call') {
   if (!client) { client = new Client({ name: 'fake-agy', version: '1.0.0' }); const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(h => [h.name, h.value])) } }); await client.connect(transport); await client.listTools(); }
   try { const result = await client.callTool({ name: step.name, arguments: step.args, _meta: { progressToken: 'fake-progress' } }); log({ event: 'tool-result', result }); update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.content.map(c => c.text || '').join('') } }); } catch (error) { log({ event: 'tool-error', message: String(error) }); }
  }
  if (step.type === 'exit') process.exit(17);
  if (step.type === 'wait') return;
  if (step.type === 'reply') send({ jsonrpc: '2.0', id, result: { stopReason: step.stopReason || 'end_turn', usage: step.usage } });
 }
}
createInterface({ input: process.stdin }).on('line', line => {
 const msg = JSON.parse(line); log({ event: 'received', message: msg });
 if (!msg.method) { const resolve = pending.get(msg.id); if (resolve) { pending.delete(msg.id); resolve(msg.result); } return; }
 if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
 else if (msg.method === 'session/new') { server = msg.params.mcpServers[0]; send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-session', models: { availableModels: [{ modelId: 'gemini-3.8-flash-low' }] }, configOptions: [] } }); }
 else if (msg.method === 'session/set_model') send({ jsonrpc: '2.0', id: msg.id, result: {} });
 else if (msg.method === 'session/prompt') void run(msg.id).catch(error => { log({ event: 'script-error', message: String(error) }); process.exit(1); });
 else if (msg.method === 'test/error') send({ jsonrpc: '2.0', id: msg.id, error: { code: 42, message: 'test error', data: { detail: true } } });
 else if (msg.method === 'test/raw') { process.stdout.write('raw output\n'); send({ jsonrpc: '2.0', id: msg.id, result: 'ok' }); }
 else if (msg.method === 'test/unknown') { void request('unsupported/method', {}).then(result => log({ event: 'unknown-result', result })); send({ jsonrpc: '2.0', id: msg.id, result: 'ok' }); }
});
