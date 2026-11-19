import { antigravityCatalog } from "../../agent/antigravity/runtime-source.ts";
import {
	ANTIGRAVITY_ACTIONS, ANTIGRAVITY_REQUEST_HEADER, type AntigravityAction, type AntigravityStatus,
} from "../../core/contracts/antigravity.ts";
import { subscriptionRequestOrigin } from "../desktop-access.ts";
import {
	AntigravityAccountError, antigravitySignedOut, readAntigravityAccount, refreshModels, signIn,
} from "./account.ts";
import { antigravityEnabled } from "./config.ts";
import { AntigravityRuntimeError, antigravityInstallation, isNewerAntigravityVersion } from "./installation.ts";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const { platformSupported, currentRuntime, checkLatestVersion, latestVersion, installRuntime, removeRuntime } = antigravityInstallation;

let active: AntigravityAction | null = null;
let progress: string | undefined;
let authorizationUrl: string | undefined;
let runtimeError: string | undefined;
let accountError: string | undefined;

function status(): AntigravityStatus {
	const enabled = antigravityEnabled();
	const current = currentRuntime();
	const latest = latestVersion();
	const catalog = antigravityCatalog();
	const account = readAntigravityAccount();
	const installing = active === "install" || active === "update";
	const signingIn = active === "sign-in";
	return {
		enabled,
		platformSupported,
		runtime: {
			state: installing ? "installing" : runtimeError ? "error" : current ? "installed" : "not-installed",
			version: current?.version ?? null,
			latestVersion: latest,
			...(current && latest && isNewerAntigravityVersion(latest, current.version) ? { updateAvailable: true } : {}),
			...(installing && progress ? { progress } : {}),
			...(runtimeError ? { error: runtimeError } : {}),
		},
		account: {
			state: signingIn ? "signing-in" : account ? "signed-in" : antigravitySignedOut() ? "signed-out" : accountError ? "error" : "unknown",
			tier: account?.tier ?? null,
			...(enabled && signingIn && authorizationUrl ? { authorizationUrl } : {}),
			...(accountError ? { error: accountError } : {}),
		},
		models: catalog.models,
		modelsUpdatedAt: catalog.updatedAt || null,
	};
}

async function readStatus() {
	if (antigravityEnabled() && currentRuntime() && !active) await checkLatestVersion();
	return status();
}

class ActionFailure extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}

const ACTION_ERRORS: Record<AntigravityAction, string> = {
	install: "Could not install the Antigravity runtime. Try again.",
	update: "Could not update the Antigravity runtime. Try again.",
	remove: "Could not remove the Antigravity runtime. Try again.",
	"sign-in": "Could not sign in to Antigravity. Try again.",
	refresh: "Could not refresh the Antigravity models. Try again.",
};

async function runAction(action: AntigravityAction): Promise<AntigravityStatus> {
	if (active) throw new ActionFailure("An Antigravity action is already in progress.", 409);
	const needsRuntime = action === "sign-in" || action === "refresh";
	if (needsRuntime && !currentRuntime()) throw new ActionFailure("Install the Antigravity runtime first.", 409);
	if (!platformSupported && (action === "install" || action === "update")) {
		throw new ActionFailure("Google does not publish Antigravity for this platform.", 400);
	}
	active = action;
	if (needsRuntime) accountError = undefined;
	else runtimeError = undefined;

	const work = Promise.resolve().then(async () => {
		switch (action) {
			case "install":
			case "update": await installRuntime((value) => { progress = value; }); break;
			case "remove": removeRuntime(); break;
			case "sign-in": await signIn((url) => { authorizationUrl = url; }); break;
			case "refresh": await refreshModels(); break;
		}
	}).catch((error: unknown) => {
		const message = error instanceof AntigravityRuntimeError || error instanceof AntigravityAccountError
			? error.message : ACTION_ERRORS[action];
		if (needsRuntime) accountError = message;
		else runtimeError = message;
		throw new ActionFailure(message, 409);
	}).finally(() => {
		active = null;
		progress = undefined;
		authorizationUrl = undefined;
	});

	if (background(action)) void work.catch(() => undefined);
	else await work;
	return status();
}

function background(action: AntigravityAction): boolean {
	return action === "install" || action === "update" || action === "sign-in";
}

interface AntigravityHttpDeps {
	enabled(): boolean;
	readStatus(): AntigravityStatus | Promise<AntigravityStatus>;
	runAction(action: AntigravityAction): AntigravityStatus | Promise<AntigravityStatus>;
}

export async function antigravityResponse(
	request: Request,
	deps: AntigravityHttpDeps = { enabled: antigravityEnabled, readStatus, runAction },
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	if ((request.method !== "GET" && request.method !== "POST") || !origin
		|| request.headers.get(ANTIGRAVITY_REQUEST_HEADER) !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "Antigravity controls require a same-origin LearnHarness request." }, { status: 403, headers: HEADERS });
	}
	if (request.method === "GET") return Response.json(await deps.readStatus(), { headers: HEADERS });

	const body = await request.json().catch(() => null) as { action?: AntigravityAction } | null;
	if (!deps.enabled()) return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers: HEADERS });
	const action = body?.action;
	if (!action || !ANTIGRAVITY_ACTIONS.includes(action)) {
		return Response.json({ error: "Unsupported Antigravity action." }, { status: 400, headers: HEADERS });
	}
	try {
		return Response.json(await deps.runAction(action), { status: background(action) ? 202 : 200, headers: HEADERS });
	} catch (error) {
		const failure = error instanceof ActionFailure ? error : new ActionFailure(ACTION_ERRORS[action], 500);
		return Response.json({ error: failure.message }, { status: failure.status, headers: HEADERS });
	}
}
