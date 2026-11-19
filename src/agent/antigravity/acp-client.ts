import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { externalCliEnv } from "../../core/auth-env.ts";
import {
	ANTIGRAVITY_THINKING_SUFFIXES,
	type AntigravityCatalog,
	type AntigravityModel,
	type AntigravityThinkingSuffix,
} from "../../core/contracts/antigravity.ts";

/** ACP protocol version LearnHarness speaks (agy 1.5 answers 1). */
export const ACP_PROTOCOL_VERSION = 1;

/** Printed by agy (non-JSON stdout) when it needs a browser sign-in. */
export const ANTIGRAVITY_AUTH_URL_PREFIX = "Open the following link to authenticate the ACP server: ";

/** Ambient Google credentials must never pick another account or billing project. */
const REMOVED_ENV_KEYS = new Set([
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GCLOUD_PROJECT",
	"CLOUDSDK_CORE_PROJECT",
	"GEMINI_HOME",
	"AGY_ADC_AUTH",
	"ELECTRON_RUN_AS_NODE",
]);

export interface AntigravityLaunchSpec {
	/** Absolute path of the managed `antigravity` executable. */
	binary: string;
	/** Private GEMINI_HOME / --gemini-dir: isolates hooks, MCP, skills and rules. */
	profileDir: string;
}

export function antigravityArgs(profileDir: string): string[] {
	return [
		"acp",
		"--gemini-dir",
		profileDir,
		// Joined beneath --gemini-dir by the CLI.
		"--app-data-dir",
		"antigravity-acp",
		"--include-default-customizations=false",
		"--disable-telemetry",
	];
}

export function antigravityEnv(profileDir: string, base: Record<string, string | undefined> = externalCliEnv()): NodeJS.ProcessEnv {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(base)) {
		if (!REMOVED_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
	}
	return { ...env, GEMINI_HOME: profileDir } as unknown as NodeJS.ProcessEnv;
}

export class AcpRequestError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
	}
}

export class AcpClosedError extends Error {}

type JsonRpcId = number | string;
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export type SpawnAcp = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export const defaultSpawnAcp: SpawnAcp = (binary, args, options) =>
	spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe", windowsHide: true });

/** Minimal NDJSON JSON-RPC 2.0 peer over a child's stdio. */
export class AcpConnection {
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private notificationHandler: ((method: string, params: unknown) => void) | undefined;
	private rawLineHandler: ((line: string) => void) | undefined;
	private closeHandlers: ((reason: string) => void)[] = [];
	private stderrTail = "";
	private closedReason: string | undefined;
	private killTimer: NodeJS.Timeout | undefined;

	constructor(readonly child: ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-16_384); });
		child.stdin.on("error", () => { /* surfaced through close */ });
		createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
		child.once("error", (error) => this.handleClose(`agy failed to start: ${error.message}`));
		child.once("close", (code, signal) => this.handleClose(`agy exited with ${signal ?? `code ${code}`}`));
	}

	get closed(): boolean { return this.closedReason !== undefined; }

	get stderr(): string { return this.stderrTail; }

	onNotification(handler: (method: string, params: unknown) => void): void { this.notificationHandler = handler; }

	onRequest(method: string, handler: RequestHandler): void { this.requestHandlers.set(method, handler); }

	onRawLine(handler: (line: string) => void): void { this.rawLineHandler = handler; }

	onClose(handler: (reason: string) => void): void {
		if (this.closedReason !== undefined) handler(this.closedReason);
		else this.closeHandlers.push(handler);
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		if (this.closedReason !== undefined) return Promise.reject(new AcpClosedError(this.closedReason));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.closedReason === undefined) this.write({ jsonrpc: "2.0", method, params });
	}

	kill(): void {
		if (this.closedReason !== undefined || this.killTimer) return;
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
		this.killTimer.unref();
	}

	private write(message: unknown): void {
		try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
		catch { /* closed; close handler settles pending requests */ }
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let message: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			message = parsed as Record<string, unknown>;
		} catch {
			this.rawLineHandler?.(trimmed);
			return;
		}
		const id = message.id as JsonRpcId | undefined;
		const method = typeof message.method === "string" ? message.method : undefined;
		if (method !== undefined && id !== undefined) { void this.answer(id, method, message.params); return; }
		if (method !== undefined) { this.notificationHandler?.(method, message.params); return; }
		if (id === undefined) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
		if (error) pending.reject(new AcpRequestError(typeof error.code === "number" ? error.code : -32603, typeof error.message === "string" ? error.message : "ACP request failed", error.data));
		else pending.resolve(message.result);
	}

	private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } });
			return;
		}
		try {
			const result = await handler(params);
			this.write({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (error) {
			this.write({ jsonrpc: "2.0", id, error: { code: error instanceof AcpRequestError ? error.code : -32603, message: error instanceof Error ? error.message : "request failed" } });
		}
	}

	private handleClose(reason: string): void {
		if (this.closedReason !== undefined) return;
		this.closedReason = reason;
		clearTimeout(this.killTimer);
		for (const pending of this.pending.values()) pending.reject(new AcpClosedError(reason));
		this.pending.clear();
		const handlers = this.closeHandlers;
		this.closeHandlers = [];
		for (const handler of handlers) handler(reason);
	}
}

/** Launch `agy acp` and complete `initialize`. Never advertises fs/terminal:
 * agy's built-in file and command tools must not get a client to act through. */
export async function startAcp(spec: AntigravityLaunchSpec, cwd: string, spawnAcp: SpawnAcp = defaultSpawnAcp): Promise<{ connection: AcpConnection; initialize: AcpInitializeResult }> {
	const connection = new AcpConnection(spawnAcp(spec.binary, antigravityArgs(spec.profileDir), { cwd, env: antigravityEnv(spec.profileDir) }));
	try {
		const initialize = await connection.request<AcpInitializeResult>("initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		return { connection, initialize };
	} catch (error) {
		connection.kill();
		throw error;
	}
}

export interface AcpInitializeResult {
	protocolVersion?: number;
	agentInfo?: { name?: string; version?: string };
	authMethods?: { id: string; name?: string }[];
	agentCapabilities?: { _meta?: { antigravity?: { systemPrompt?: { append?: boolean } } } };
}

export interface AcpConfigOption {
	id: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options?: { value: string; name?: string }[];
}

export interface AcpNewSessionResult {
	sessionId: string;
	models?: { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string };
	configOptions?: AcpConfigOption[];
}

export interface AcpHttpMcpServer {
	type: "http";
	name: string;
	url: string;
	headers: { name: string; value: string }[];
}

export function newSessionParams(cwd: string, mcpServers: AcpHttpMcpServer[], systemPrompt: string): Record<string, unknown> {
	return {
		cwd,
		mcpServers,
		...(systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}),
	};
}

/** Plan tier from `authenticate`'s or a session's `_meta`, when reported. */
export function tierFromMeta(result: unknown): string | null {
	const tier = (result as { _meta?: { antigravity?: { tier?: { name?: unknown } } } } | null)?._meta?.antigravity?.tier;
	return typeof tier?.name === "string" && tier.name.trim() ? tier.name.trim() : null;
}

function isSuffix(value: string): value is AntigravityThinkingSuffix {
	return (ANTIGRAVITY_THINKING_SUFFIXES as readonly string[]).includes(value);
}

/** Base models from agy's `model` option; thinking levels from the matching
 * `<base>-<level>` variants in availableModels (agy's own encoding). */
export function catalogFromSession(result: AcpNewSessionResult, contextWindow: number | null, now = Date.now()): AntigravityCatalog {
	const variants = result.models?.availableModels?.map((model) => model.modelId) ?? [];
	const modelOption = result.configOptions?.find((option) => option.id === "model" || option.category === "model");
	const bases = modelOption?.options?.length
		? modelOption.options.map((option) => ({ id: option.value, name: option.name ?? option.value }))
		: (result.models?.availableModels ?? []).map((model) => ({ id: model.modelId, name: model.name ?? model.modelId }));
	const seen = new Set<string>();
	const models: AntigravityModel[] = [];
	for (const base of bases) {
		if (!base.id || seen.has(base.id)) continue;
		seen.add(base.id);
		const levels = variants.flatMap((variant) => {
			if (!variant.startsWith(`${base.id}-`)) return [];
			const suffix = variant.slice(base.id.length + 1);
			return isSuffix(suffix) ? [suffix] : [];
		});
		models.push({ id: base.id, name: base.name, thinkingLevels: ANTIGRAVITY_THINKING_SUFFIXES.filter((level) => levels.includes(level)) });
	}
	return { models, contextWindow, updatedAt: now };
}

/** agy's selectable model id for a base model and requested level. */
export function variantModelId(model: AntigravityModel, level: string | undefined): string {
	if (model.thinkingLevels.length === 0) return model.id;
	const wanted = level && isSuffix(level) && model.thinkingLevels.includes(level) ? level
		: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]!;
	return `${model.id}-${wanted}`;
}
