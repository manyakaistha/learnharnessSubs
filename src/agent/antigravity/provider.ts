import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction, type ThinkingLevel } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_PROVIDER, type AntigravityCatalog, type AntigravityModel } from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-acp";

/** Used only when agy has not yet reported its session context size. */
const FALLBACK_CONTEXT_WINDOW = 1_000_000;

const LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function antigravityPiModel(model: AntigravityModel, contextWindow: number | null): Model<Api> {
	const supported = new Set<string>(model.thinkingLevels);
	return {
		id: model.id,
		name: model.name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		// Pi-required placeholders, not prices: the Antigravity subscription bills.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: model.thinkingLevels.length > 0,
		// agy has no thinking-off variant; unsupported levels clamp to supported ones.
		thinkingLevelMap: {
			off: null,
			...Object.fromEntries(LEVELS.map((level) => [level, supported.has(level) ? level : null])),
		},
		contextWindow: contextWindow ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: 65_536,
	};
}

export function antigravityPiModels(catalog: AntigravityCatalog): Model<Api>[] {
	return catalog.models.map((model) => antigravityPiModel(model, catalog.contextWindow));
}

export function createAntigravityProvider(catalog: AntigravityCatalog, streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: antigravityPiModels(catalog),
		api: { stream: streamSimple, streamSimple },
	});
}
