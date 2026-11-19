import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import type { LhMessage } from "../../core/native-messages.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, type PendingToolCall, type ToolBridge } from "../claude-code/tool-bridge.ts";
import { toClaudeInput, type ClaudeContentBlock } from "../claude-code/transcript.ts";
import {
	AcpClosedError,
	AcpRequestError,
	newSessionParams,
	startAcp,
	variantModelId,
	type AcpConnection,
	type AcpNewSessionResult,
	type AntigravityLaunchSpec,
	type SpawnAcp,
} from "./acp-client.ts";
import { acquireAntigravityBinary, antigravityCatalog, antigravityLaunchSpec, reportAntigravitySignedOut } from "./runtime-source.ts";

export const ANTIGRAVITY_UNAVAILABLE = "Antigravity is unavailable. Enable it, install its runtime and sign in under Settings → Providers → Antigravity.";
export const ANTIGRAVITY_NOT_SIGNED_IN = "Antigravity is not signed in. Sign in under Settings → Providers → Antigravity.";
const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "Antigravity failed to start";
const REFUSAL_MESSAGE = "The model refused to complete the request";
const IDENTITY_ERROR = "Antigravity compatibility error: MCP call does not match an approved tool request";

/** agy names MCP tools `mcp_<server>_<tool>` in permission requests and updates. */
const MCP_PERMISSION_PREFIX = `mcp_${BRIDGE_SERVER_NAME}_`;

/** Arguments agy adds to every tool call and strips before the MCP request,
 * unless the tool declares them itself. */
const AGY_INJECTED_ARGUMENTS = ["toolSummary", "explanation", "toolAction", "waitForPreviousTools"];

/** Gather parallel calls into one batch before handing them to Pi. */
const ADMISSION_SETTLE_MS = 100;

const STOP_REASONS: Record<string, Extract<StopReason, "stop" | "length" | "aborted" | "error">> = {
	end_turn: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
	cancelled: "aborted",
	refusal: "error",
};

/** agy's own system prompt describes a coding agent; this appended preamble
 * scopes it to LearnHarness and its harness tools. */
export function toSystemPrompt(systemPrompt: string): string {
	return [
		"You are running inside LearnHarness, a learning app. The LearnHarness instructions below override any earlier instructions about coding, workspaces, files, terminals, browsers, web search, plans, tasks or subagents.",
		`Your only working tools are the \`${BRIDGE_SERVER_NAME}\` MCP tools. Built-in file, terminal, browser, web, scheduling and subagent tools are disabled here and will fail; never call them.`,
		"",
		systemPrompt,
	].join("\n");
}

type AcpContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function toAcpPrompt(blocks: ClaudeContentBlock[]): AcpContentBlock[] {
	return blocks.map((block) => block.type === "text"
		? { type: "text", text: block.text }
		: { type: "image", data: block.source.data, mimeType: block.source.media_type });
}

type PromptUsage = { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number };

type BufferedEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "result"; stopReason: string; usage?: PromptUsage }
	| { type: "error"; message: string };

function createOutput(model: Model<Api>): AssistantMessage & Pick<LhMessage, "cliContextWindow"> {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

class AntigravityTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private open: { type: "text" | "thinking"; index: number } | null = null;
	private started = false;
	finished = false;

	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage { return this.output; }

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined) this.output.cliContextWindow = tokens;
	}

	delta(type: "text" | "thinking", text: string): void {
		if (this.finished || !text) return;
		this.start();
		if (this.open?.type !== type) {
			this.closeOpen();
			const index = this.output.content.length;
			if (type === "text") {
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex: index, partial: this.output });
			} else {
				this.output.content.push({ type: "thinking", thinking: "" });
				this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.output });
			}
			this.open = { type, index };
		}
		const block = this.output.content[this.open.index]!;
		if (block.type === "text") {
			block.text += text;
			this.stream.push({ type: "text_delta", contentIndex: this.open.index, delta: text, partial: this.output });
		} else if (block.type === "thinking") {
			block.thinking += text;
			this.stream.push({ type: "thinking_delta", contentIndex: this.open.index, delta: text, partial: this.output });
		}
	}

	admit(calls: ToolCall[], contextUsed: number | undefined): void {
		if (this.finished) return;
		this.setContextUsage(contextUsed);
		this.start();
		this.closeOpen();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.done("toolUse");
	}

	complete(stopReason: string, usage: PromptUsage | undefined, contextUsed: number | undefined): void {
		if (this.finished) return;
		this.setUsage(usage, contextUsed);
		const mapped = STOP_REASONS[stopReason];
		if (mapped === "aborted") { this.fail(ABORT_MESSAGE, "aborted"); return; }
		if (!mapped) { this.fail(`Antigravity ended the turn with an unknown stop reason: ${stopReason}`, "error"); return; }
		if (stopReason === "refusal") { this.fail(REFUSAL_MESSAGE, "error"); return; }
		if (mapped === "error") { this.fail(REFUSAL_MESSAGE, "error"); return; }
		this.start();
		this.closeOpen();
		this.done(mapped);
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.closeOpen();
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	/** LearnHarness measures context from the latest message's usage buckets.
	 * agy's prompt usage sums every model call of a tool loop, so the context
	 * figure comes from `usage_update.used` (the latest call's input + output). */
	private setContextUsage(contextUsed: number | undefined, output = 0): void {
		if (contextUsed === undefined || contextUsed <= 0) return;
		const input = Math.max(0, contextUsed - output);
		Object.assign(this.output.usage, { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output });
	}

	private setUsage(usage: PromptUsage | undefined, contextUsed: number | undefined): void {
		const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
		if (contextUsed !== undefined && contextUsed > 0) {
			// Output tokens of the whole prompt, bounded by the measured context.
			this.setContextUsage(contextUsed, Math.min(count(usage?.outputTokens), contextUsed));
		} else if (usage) {
			// No context report: agy's uncached input, cached reads, and output.
			const cacheRead = count(usage.cachedReadTokens);
			const cacheWrite = count(usage.cachedWriteTokens);
			const input = count(usage.inputTokens);
			const output = count(usage.outputTokens);
			Object.assign(this.output.usage, { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });
		}
		if (usage?.thoughtTokens !== undefined) this.output.usage.reasoning = count(usage.thoughtTokens);
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeOpen(): void {
		if (!this.open) return;
		const block = this.output.content[this.open.index]!;
		if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: this.open.index, content: block.text, partial: this.output });
		else if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: this.open.index, content: block.thinking, partial: this.output });
		this.open = null;
	}

	private done(reason: "stop" | "length" | "toolUse"): void {
		this.finished = true;
		this.output.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
	}
}

type Intent = { id: string; name: string; arguments: JsonObject; used: boolean };

function stripInjected(intent: JsonObject, actual: JsonObject): JsonObject {
	const result: JsonObject = { ...intent };
	for (const key of AGY_INJECTED_ARGUMENTS) if (!(key in actual)) delete result[key];
	return result;
}

function isAuthError(error: unknown): boolean {
	if (!(error instanceof AcpRequestError)) return false;
	return error.code === -32000 || /auth|sign.?in|log.?in|credential/i.test(error.message);
}

function errorMessage(error: unknown): string {
	if (isAuthError(error)) { reportAntigravitySignedOut(); return ANTIGRAVITY_NOT_SIGNED_IN; }
	if (error instanceof AcpRequestError) return `Antigravity: ${error.message}`;
	if (error instanceof AcpClosedError) return `Antigravity stopped: ${error.message}`;
	return START_FAILED_MESSAGE;
}

class AntigravityProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private readonly intents: Intent[] = [];
	private admitted: PendingToolCall[] = [];
	private buffered: BufferedEvent[] = [];
	private stopping = false;
	private cleaned = false;
	private settleTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private acpSessionId: string | undefined;
	private contextWindow: number | undefined;
	/** Context after agy's latest model call (`usage_update.used`). */
	private contextUsed: number | undefined;
	bridge!: ToolBridge;

	constructor(
		private readonly connection: AcpConnection,
		private readonly cwd: string,
		private readonly release: () => void,
		private turn: AntigravityTurn,
		private readonly tools: Tool[],
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {
		connection.onRequest("session/request_permission", (params) => this.permission(params));
		connection.onNotification((method, params) => { if (method === "session/update") this.update(params); });
		connection.onClose((reason) => this.handleClose(reason));
	}

	/** Called by the bridge: match an MCP request to an approved permission. */
	identify(request: { name: string; arguments: JsonObject }): string | undefined {
		const intent = this.intents.find((candidate) => !candidate.used && candidate.name === request.name
			&& isDeepStrictEqual(stripInjected(candidate.arguments, request.arguments), request.arguments));
		if (!intent) return undefined;
		intent.used = true;
		return intent.id;
	}

	async run(model: string, systemPrompt: string, prompt: AcpContentBlock[], signal: AbortSignal | undefined): Promise<void> {
		this.setSignal(signal);
		if (this.stopping) return;
		const mcpServers = [{ type: "http" as const, name: BRIDGE_SERVER_NAME, url: this.bridge.url, headers: [{ name: "Authorization", value: this.bridge.authorization }] }];
		const session = await this.connection.request<AcpNewSessionResult>("session/new", newSessionParams(this.cwd, mcpServers, toSystemPrompt(systemPrompt)));
		if (this.stopping) return;
		this.acpSessionId = session.sessionId;
		await this.connection.request("session/set_model", { sessionId: session.sessionId, modelId: model });
		if (this.stopping) return;
		const result = await this.connection.request<{ stopReason?: string; usage?: PromptUsage }>("session/prompt", { sessionId: session.sessionId, prompt });
		this.event({ type: "result", stopReason: result?.stopReason ?? "end_turn", usage: result?.usage });
	}

	fail(message: string): void {
		this.event({ type: "error", message });
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: AntigravityTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.setSignal(signal);
		if (this.stopping) return;
		const buffered = this.buffered;
		this.buffered = [];
		for (const event of buffered) this.event(event);
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.scheduleAdmission();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping) return;
		this.stopping = true;
		clearTimeout(this.settleTimer);
		if (this.acpSessionId) this.connection.notify("session/cancel", { sessionId: this.acpSessionId });
		this.connection.kill();
	}

	/** agy abandoned a call (e.g. its MCP timeout) Pi already owns: this
	 * session can no longer receive the result. Kill it; the continuation
	 * then replays fresh history that carries the tool result. */
	cancelCall(call: PendingToolCall): void {
		if (this.admitted.some((admitted) => admitted.id === call.id)) this.kill();
	}

	scheduleAdmission(): void {
		clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => this.flushAdmissions(), ADMISSION_SETTLE_MS);
		this.settleTimer.unref();
	}

	/** Only authenticated MCP requests matching an approved permission execute. */
	private flushAdmissions(): void {
		if (this.stopping || this.turn.finished) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;
		const calls: ToolCall[] = pending.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }));
		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		this.turn.admit(calls, this.contextUsed);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope: return the batch, then use fresh replay.
	}

	private permission(params: unknown): unknown {
		const request = params as { toolCall?: { toolCallId?: unknown; name?: unknown; rawInput?: unknown }; options?: { optionId: string; kind?: string }[] };
		const options = request.options ?? [];
		const pick = (prefix: string) => options.find((option) => option.kind?.startsWith(prefix))?.optionId;
		const name = typeof request.toolCall?.name === "string" ? request.toolCall.name : "";
		const id = typeof request.toolCall?.toolCallId === "string" ? request.toolCall.toolCallId : "";
		const toolName = name.startsWith(MCP_PERMISSION_PREFIX) ? name.slice(MCP_PERMISSION_PREFIX.length) : "";
		const raw = request.toolCall?.rawInput;
		const declared = !!toolName && this.tools.some((tool) => tool.name === toolName);
		const allow = pick("allow_once") ?? pick("allow");
		if (!this.stopping && declared && id && allow && !this.intents.some((intent) => intent.id === id)
			&& raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
			this.intents.push({ id, name: toolName, arguments: raw as JsonObject, used: false });
			return { outcome: { outcome: "selected", optionId: allow } };
		}
		// Built-in agy tools (files, commands, browser, web) never run for LearnHarness.
		const reject = pick("reject_once") ?? pick("reject");
		return reject ? { outcome: { outcome: "selected", optionId: reject } } : { outcome: { outcome: "cancelled" } };
	}

	private update(params: unknown): void {
		const update = (params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: unknown }; size?: unknown; used?: unknown } } | null)?.update;
		switch (update?.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
				if (text) this.event({ type: update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", text });
				return;
			}
			case "usage_update":
				if (typeof update.size === "number" && Number.isSafeInteger(update.size) && update.size > 0) {
					this.contextWindow = update.size;
					this.turn.setContextWindow(update.size);
				}
				if (typeof update.used === "number" && Number.isSafeInteger(update.used) && update.used > 0) this.contextUsed = update.used;
				return;
		}
	}

	/** While Pi runs admitted tools the turn is finished; later events wait for its continuation. */
	private event(event: BufferedEvent): void {
		if (this.turn.finished) {
			if (this.stopping || this.admitted.length === 0) return;
			// Ending the prompt while Pi still owes a result means agy gave up
			// on it; replaying that ending would silently drop the result.
			if (event.type === "result" || event.type === "error") { this.kill(); return; }
			this.buffered.push(event);
			return;
		}
		switch (event.type) {
			case "text":
			case "thinking":
				this.turn.delta(event.type, event.text);
				return;
			case "result":
				if (this.bridge.getPendingToolCalls().length > 0) {
					this.turn.fail("Antigravity ended its turn while harness tool calls were waiting for results", "error");
				} else {
					this.turn.complete(event.stopReason, event.usage, this.contextUsed);
				}
				this.kill();
				return;
			case "error":
				this.turn.fail(event.message, "error");
				this.kill();
				return;
		}
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleClose(reason: string): void {
		removeLiveProcess(this);
		this.stopping = true;
		clearTimeout(this.settleTimer);
		this.signal?.removeEventListener("abort", this.abort);
		const stderr = this.connection.stderr.trim();
		if (stderr) console.error("agy stderr:", stderr.slice(-4_096));
		this.turn.fail(`Antigravity stopped: ${reason}`, "error");
		void this.cleanup();
	}

	private async cleanup(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		this.release();
		await Promise.all([this.bridge?.close(), rm(this.cwd, { recursive: true, force: true })]).catch((error: unknown) => {
			console.error("Antigravity cleanup failed:", error);
		});
	}
}

function continueLiveProcess(turn: AntigravityTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AntigravityProcess)) return false;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(
	spec: AntigravityLaunchSpec,
	spawnAcp: SpawnAcp | undefined,
	turn: AntigravityTurn,
	modelId: string,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toClaudeInput(context.messages);
	const cwd = await mkdtemp(join(tmpdir(), "antigravity-cwd-"));
	const release = acquireAntigravityBinary(spec.binary);
	let started: Awaited<ReturnType<typeof startAcp>>;
	try {
		started = await startAcp(spec, cwd, spawnAcp);
	} catch (error) {
		release();
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}
	const process = new AntigravityProcess(started.connection, cwd, release, turn, input.tools, owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	try {
		process.bridge = await createToolBridge(input.tools, {
			onCall: () => process.scheduleAdmission(),
			onError: (error) => process.fail(error.message),
			onCancel: (call) => process.cancelCall(call),
		}, {
			identify: (request) => process.identify(request),
			identityError: IDENTITY_ERROR,
			// Otherwise agy loads MCP tools on demand behind a discovery step.
			toolMeta: { "antigravity/alwaysLoad": true },
		});
	} catch (error) {
		process.kill();
		throw error;
	}
	process.run(modelId, input.systemPrompt, toAcpPrompt(input.userContent), options?.signal).catch((error: unknown) => {
		if (!(error instanceof AcpRequestError)) console.error("Antigravity turn failed:", error);
		process.fail(options?.signal?.aborted ? ABORT_MESSAGE : errorMessage(error));
	});
}

export function createAntigravityStreamFunction(
	resolveSpec: () => AntigravityLaunchSpec | null = antigravityLaunchSpec,
	spawnAcp?: SpawnAcp,
): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AntigravityTurn(stream, model);
		const spec = resolveSpec();
		if (!spec) { turn.fail(ANTIGRAVITY_UNAVAILABLE, "error"); return stream; }
		const catalogModel = antigravityCatalog().models.find((candidate) => candidate.id === model.id);
		const modelId = catalogModel ? variantModelId(catalogModel, options?.reasoning) : model.id;
		// A new runtime/profile must not continue a child launched with the old one.
		const configuration = { request: configurationForReuse(model, context, modelId), spec };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;
		startProcess(spec, spawnAcp, turn, modelId, context, options, owner, configuration).catch((error: unknown) => {
			console.error("Antigravity turn failed to start:", error);
			turn.fail(options?.signal?.aborted ? ABORT_MESSAGE : errorMessage(error), options?.signal?.aborted ? "aborted" : "error");
		});
		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction();
