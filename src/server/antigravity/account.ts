import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ANTIGRAVITY_DIR } from "../../../config.ts";
import {
	ANTIGRAVITY_AUTH_URL_PREFIX, AcpRequestError, catalogFromSession, defaultSpawnAcp,
	newSessionParams, startAcp, tierFromMeta, type AcpConnection, type AcpNewSessionResult,
} from "../../agent/antigravity/acp-client.ts";
import { acquireAntigravityBinary, setAntigravityCatalog } from "../../agent/antigravity/runtime-source.ts";
import { ANTIGRAVITY_THINKING_SUFFIXES, type AntigravityCatalog } from "../../core/contracts/antigravity.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { currentRuntime } from "./installation.ts";

const profileDir = path.join(/* turbopackIgnore: true */ ANTIGRAVITY_DIR, "profile");
const accountFile = path.join(/* turbopackIgnore: true */ ANTIGRAVITY_DIR, "account.json");
const catalogFile = path.join(/* turbopackIgnore: true */ ANTIGRAVITY_DIR, "models.json");

export class AntigravityAccountError extends Error {}

export function ensureAntigravityProfile(): string {
	fs.mkdirSync(/* turbopackIgnore: true */ profileDir, { recursive: true, mode: 0o700 });
	return profileDir;
}

interface Account {
	tier: string | null;
	signedInAt: number;
}

function readRecord(file: string): unknown {
	try { return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")); }
	catch { return null; }
}

export function readAntigravityAccount(): Account | null {
	const account = readRecord(accountFile) as Partial<Account> | null;
	return account && (account.tier === null || typeof account.tier === "string")
		&& typeof account.signedInAt === "number" && Number.isFinite(account.signedInAt)
		? { tier: account.tier, signedInAt: account.signedInAt } : null;
}

export function readAntigravityCatalog(): AntigravityCatalog | null {
	const catalog = readRecord(catalogFile) as AntigravityCatalog | null;
	if (!catalog || !Array.isArray(catalog.models) || !Number.isFinite(catalog.updatedAt)
		|| (catalog.contextWindow !== null && (!Number.isSafeInteger(catalog.contextWindow) || catalog.contextWindow <= 0))
		|| !catalog.models.every((model) => model && typeof model.id === "string" && model.id
			&& typeof model.name === "string" && Array.isArray(model.thinkingLevels)
			&& model.thinkingLevels.every((level) => ANTIGRAVITY_THINKING_SUFFIXES.includes(level)))) return null;
	return {
		models: catalog.models.map(({ id, name, thinkingLevels }) => ({ id, name, thinkingLevels })),
		contextWindow: catalog.contextWindow,
		updatedAt: catalog.updatedAt,
	};
}

function writeRecord(file: string, value: Account | AntigravityCatalog) {
	writeFileAtomicSync(file, JSON.stringify(value), { mode: 0o600 });
}

let signedOut = false;

export function antigravitySignedOut(): boolean { return signedOut; }

export function markAntigravitySignedOut(): void {
	fs.rmSync(/* turbopackIgnore: true */ accountFile, { force: true });
	signedOut = true;
}

export function isAntigravityAuthError(error: unknown): boolean {
	if (!(error instanceof AcpRequestError)) return false;
	return error.code === -32000 || error.code === 401
		|| (error.code === -32603 && /\b(?:authenticat\w*|unauthenticated|unauthorized|authoriz\w* required|sign[ -]?in|log[ -]?in|not logged in|no browser is available|401)\b/i.test(error.message));
}

function withTimeout<T>(promise: Promise<T>, timeout: number, error: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new AntigravityAccountError(error)), timeout);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function withAcp<T>(use: (connection: AcpConnection, cwd: string) => Promise<T>): Promise<T> {
	const runtime = currentRuntime();
	if (!runtime) throw new AntigravityAccountError("Install the Antigravity runtime first.");
	const profileDir = ensureAntigravityProfile();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-antigravity-"));
	const release = acquireAntigravityBinary(runtime.binary);
	let child: ReturnType<typeof defaultSpawnAcp> | undefined;
	let closed: Promise<void> | undefined;
	let connection: AcpConnection | undefined;
	try {
		const startup = startAcp({ binary: runtime.binary, profileDir }, cwd, (binary, args, options) => {
			const launched = defaultSpawnAcp(binary, args, options);
			child = launched;
			closed = new Promise((resolve) => launched.once("close", () => resolve()));
			return launched;
		});
		({ connection } = await withTimeout(startup, 10_000, "The Antigravity runtime took too long to start."));
		connection.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
		return await use(connection, cwd);
	} catch (error) {
		if (isAntigravityAuthError(error)) {
			markAntigravitySignedOut();
			throw new AntigravityAccountError("Antigravity needs a Google sign-in. Open the browser on the computer running LearnHarness and try again.");
		}
		throw error;
	} finally {
		try {
			if (connection) connection.kill();
			else child?.kill("SIGKILL");
			await closed;
		} finally {
			release();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}
}

async function discoverModels(connection: AcpConnection, cwd: string): Promise<AntigravityCatalog> {
	let contextWindow: number | null = null;
	let receivedUsage!: () => void;
	const usage = new Promise<void>((resolve) => { receivedUsage = resolve; });
	let sessionId: string | undefined;
	connection.onNotification((method, params) => {
		if (method !== "session/update") return;
		const notice = params as { sessionId?: string; update?: { sessionUpdate?: string; size?: unknown } } | null;
		if (sessionId && notice?.sessionId && notice.sessionId !== sessionId) return;
		const update = notice?.update;
		if (update?.sessionUpdate !== "usage_update" || typeof update.size !== "number"
			|| !Number.isSafeInteger(update.size) || update.size <= 0) return;
		contextWindow = update.size;
		receivedUsage();
	});

	const result = await withTimeout(connection.request<AcpNewSessionResult>("session/new", newSessionParams(cwd, [], "")),
		10_000, "Antigravity took too long to list its models.");
	sessionId = result?.sessionId;
	if (!sessionId) throw new AntigravityAccountError("Antigravity did not return a model session.");
	try {
		await withTimeout(usage, 1_000, "No Antigravity usage data yet.").catch(() => undefined);
		const catalog = catalogFromSession(result, contextWindow);
		writeRecord(catalogFile, catalog);
		setAntigravityCatalog(catalog);

		const tier = tierFromMeta(result);
		if (tier) {
			writeRecord(accountFile, { tier, signedInAt: readAntigravityAccount()?.signedInAt ?? Date.now() });
			signedOut = false;
		}
		return catalog;
	} finally {
		await withTimeout(connection.request("session/close", { sessionId }), 1_000,
			"Antigravity took too long to close its model session.").catch(() => undefined);
	}
}

export function refreshModels(): Promise<AntigravityCatalog> {
	return withAcp(discoverModels);
}

export function signIn(onAuthorizationUrl: (url: string | undefined) => void = () => undefined): Promise<AntigravityCatalog> {
	return withAcp(async (connection, cwd) => {
		connection.onRawLine((line) => {
			if (!line.startsWith(ANTIGRAVITY_AUTH_URL_PREFIX)) return;
			const url = URL.parse(line.slice(ANTIGRAVITY_AUTH_URL_PREFIX.length));
			if (url?.protocol === "https:" && !url.username && !url.password) onAuthorizationUrl(url.href);
		});
		try {
			const result = await withTimeout(connection.request("authenticate", { methodId: "oauth-personal" }),
				5 * 60_000, "Antigravity sign-in timed out. Try signing in again.");
			const account = readAntigravityAccount();
			writeRecord(accountFile, { tier: tierFromMeta(result) ?? account?.tier ?? null, signedInAt: Date.now() });
			signedOut = false;
		} finally {
			connection.onRawLine(() => undefined);
			onAuthorizationUrl(undefined);
		}
		return discoverModels(connection, cwd);
	});
}
