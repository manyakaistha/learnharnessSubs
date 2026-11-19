/** Google's official Antigravity CLI (`agy`) driven over ACP. LearnHarness
 * manages the runtime and a private profile; agy owns sign-in and billing. */
export const ANTIGRAVITY_PROVIDER = "antigravity";

/** LearnHarness thinking levels agy encodes as model-id suffixes. */
export const ANTIGRAVITY_THINKING_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AntigravityThinkingSuffix = (typeof ANTIGRAVITY_THINKING_SUFFIXES)[number];

/** One selectable base model (agy's `model` config option value). */
export interface AntigravityModel {
	/** Base id, e.g. `gemini-4-neon`; the LearnHarness model id. */
	id: string;
	name: string;
	/** Supported thinking suffixes; empty when the model has a single variant. */
	thinkingLevels: AntigravityThinkingSuffix[];
}

export interface AntigravityCatalog {
	models: AntigravityModel[];
	/** Context window agy reported for its session, when known. */
	contextWindow: number | null;
	updatedAt: number;
}

export type AntigravityRuntimeState = "not-installed" | "installing" | "installed" | "error";
export type AntigravityAccountState = "unknown" | "signing-in" | "signed-in" | "signed-out" | "error";

/** Settings status. Never carries paths, tokens, or raw CLI output. */
export interface AntigravityStatus {
	enabled: boolean;
	/** False when Google publishes no runtime for this OS/CPU. */
	platformSupported: boolean;
	runtime: {
		state: AntigravityRuntimeState;
		version: string | null;
		latestVersion: string | null;
		/** True when the manifest version is newer than the installed runtime. */
		updateAvailable?: boolean;
		/** Human-readable progress while installing. */
		progress?: string;
		error?: string;
	};
	account: {
		state: AntigravityAccountState;
		/** Plan tier name agy reports, e.g. "Google AI Pro". */
		tier: string | null;
		/** Browser fallback while agy is waiting for Google sign-in. */
		authorizationUrl?: string;
		error?: string;
	};
	models: AntigravityModel[];
	modelsUpdatedAt: number | null;
}

export type AntigravityAction = "install" | "update" | "remove" | "sign-in" | "refresh";
export const ANTIGRAVITY_ACTIONS: readonly AntigravityAction[] = ["install", "update", "remove", "sign-in", "refresh"];

/** Same-origin intent header for /api/antigravity, like Claude Code's. */
export const ANTIGRAVITY_REQUEST_HEADER = "x-learnharness-antigravity";
