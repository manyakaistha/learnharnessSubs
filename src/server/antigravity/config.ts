import { antigravityCatalog, configureAntigravitySource, setAntigravityCatalog } from "../../agent/antigravity/runtime-source.ts";
import { settingsStore } from "../../store/settings.ts";
import { ensureAntigravityProfile, markAntigravitySignedOut, readAntigravityCatalog } from "./account.ts";
import { currentRuntime } from "./installation.ts";

export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true;
}

export function antigravityAvailable(): boolean {
	return antigravityEnabled() && currentRuntime() !== null && antigravityCatalog().models.length > 0;
}

let configured = false;

export function ensureAntigravityConfigured(): void {
	if (configured) return;
	configureAntigravitySource({
		launchSpec() {
			if (!antigravityEnabled()) return null;
			const runtime = currentRuntime();
			return runtime ? { binary: runtime.binary, profileDir: ensureAntigravityProfile() } : null;
		},
		onSignedOut: markAntigravitySignedOut,
	});
	const catalog = readAntigravityCatalog();
	if (catalog) setAntigravityCatalog(catalog);
	configured = true;
}

ensureAntigravityConfigured();
