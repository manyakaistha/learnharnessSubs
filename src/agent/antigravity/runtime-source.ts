import type { AntigravityCatalog } from "../../core/contracts/antigravity.ts";
import type { AntigravityLaunchSpec } from "./acp-client.ts";

/** The server injects runtime/profile resolution and the cached account
 * catalog; the agent layer never imports server stores. */
export interface AntigravitySource {
	/** Null when disabled, not installed, or unsupported. Read per request. */
	launchSpec(): AntigravityLaunchSpec | null;
	/** agy rejected a model request for missing/expired sign-in. */
	onSignedOut?(): void;
}

let source: AntigravitySource | undefined;
let catalog: AntigravityCatalog = { models: [], contextWindow: null, updatedAt: 0 };
let revision = 0;

export function configureAntigravitySource(next: AntigravitySource): void { source = next; }

export function antigravityLaunchSpec(): AntigravityLaunchSpec | null { return source?.launchSpec() ?? null; }

export function reportAntigravitySignedOut(): void { source?.onSignedOut?.(); }

export function setAntigravityCatalog(next: AntigravityCatalog): void {
	catalog = structuredClone(next);
	revision++;
}

export function antigravityCatalog(): AntigravityCatalog { return catalog; }

/** Bumps on every catalog change so piModels() re-registers the provider. */
export function antigravityCatalogRevision(): number { return revision; }

const leases = new Map<string, number>();

/** Live agy processes lease their executable; the installer never removes
 * or replaces a leased runtime version. Returns the release function. */
export function acquireAntigravityBinary(binary: string): () => void {
	leases.set(binary, (leases.get(binary) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (leases.get(binary) ?? 1) - 1;
		if (count <= 0) leases.delete(binary);
		else leases.set(binary, count);
	};
}

export function antigravityBinariesInUse(): ReadonlySet<string> { return new Set(leases.keys()); }
