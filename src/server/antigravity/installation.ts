import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";

import { ANTIGRAVITY_DIR } from "../../../config.ts";
import { antigravityBinariesInUse } from "../../agent/antigravity/runtime-source.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";

const MANIFEST_ROOT = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";
const RELEASE_ROOT = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const MIN_VERSION = "1.5.0";

export class AntigravityRuntimeError extends Error {}

export function antigravityPlatformTarget(platform = process.platform, arch: string = process.arch): string | null {
	const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
	if (cpu === null) return null;
	if (platform === "win32") return `windows_${cpu}`;
	if (platform === "linux" || platform === "darwin") return `${platform}_${cpu}`;
	return null;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string) {
	const match = SEMVER.exec(version);
	if (!match || match[0] !== version) return null;
	const prerelease = match[4]?.split(".");
	if (prerelease?.some((part) => /^0\d+$/.test(part))) return null;
	return { numbers: match.slice(1, 4).map(BigInt), prerelease };
}

type ParsedVersion = NonNullable<ReturnType<typeof parseVersion>>;

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
	for (const [index, number] of left.numbers.entries()) {
		const other = right.numbers[index]!;
		if (number !== other) return number > other ? 1 : -1;
	}
	if (!left.prerelease || !right.prerelease) return Number(!left.prerelease) - Number(!right.prerelease);
	for (const [index, part] of left.prerelease.entries()) {
		const other = right.prerelease[index];
		if (other === undefined) return 1;
		if (part === other) continue;
		const numeric = /^\d+$/.test(part);
		const otherNumeric = /^\d+$/.test(other);
		if (numeric && otherNumeric) return BigInt(part) > BigInt(other) ? 1 : -1;
		if (numeric !== otherNumeric) return numeric ? -1 : 1;
		return part > other ? 1 : -1;
	}
	return left.prerelease.length - right.prerelease.length;
}

export function isNewerAntigravityVersion(candidate: string, installed: string): boolean {
	const left = parseVersion(candidate);
	const right = parseVersion(installed);
	return left !== null && right !== null && compareVersions(left, right) > 0;
}

function supportedVersion(value: unknown): value is string {
	const version = typeof value === "string" ? parseVersion(value) : null;
	return version !== null && compareVersions(version, parseVersion(MIN_VERSION)!) >= 0;
}

interface Release {
	version: string;
	url: string;
	sha512: string;
}

function parseRelease(raw: unknown): Release {
	const { version, url, sha512 } = (raw ?? {}) as Partial<Release>;
	const parsed = typeof url === "string" && url.startsWith(RELEASE_ROOT) ? URL.parse(url) : null;
	if (!supportedVersion(version)
		|| !parsed || !parsed.href.startsWith(RELEASE_ROOT) || parsed.pathname === new URL(RELEASE_ROOT).pathname
		|| typeof sha512 !== "string" || sha512.length !== 128 || !/^[0-9a-f]+$/i.test(sha512)) {
		throw new AntigravityRuntimeError("Google returned an invalid Antigravity release manifest.");
	}
	return { version, url: parsed.href, sha512: sha512.toLowerCase() };
}

type Download = (url: string) => Promise<Response>;
type Extract = (archive: string, directory: string) => Promise<void>;
type Progress = (message: string) => void;

interface RuntimeOptions {
	directory?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	fetchManifest?: typeof fetch;
	download?: Download;
	extract?: Extract;
	binariesInUse?: () => ReadonlySet<string>;
}

async function extractTar(archive: string, directory: string) {
	await promisify(execFile)("tar", ["-xzf", archive, "-C", directory]);
}

async function downloadRelease(release: Release, file: string, download: Download, onProgress: Progress) {
	onProgress("Downloading");
	const response = await download(release.url);
	if (!response.ok || !response.body) throw new AntigravityRuntimeError("Could not download the Antigravity runtime from Google.");

	const total = Number(response.headers.get("content-length"));
	const hash = createHash("sha512");
	let bytes = 0;
	let percent = 0;
	const checksum = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			bytes += chunk.length;
			if (total > 0) {
				const next = Math.min(100, Math.floor(bytes / total * 100));
				if (next !== percent) {
					percent = next;
					onProgress(`Downloading ${percent}%`);
				}
			}
			callback(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), checksum, fs.createWriteStream(file, { flags: "wx", mode: 0o600 }));
	onProgress("Verifying");
	if (hash.digest("hex") !== release.sha512) {
		throw new AntigravityRuntimeError("The Antigravity download failed its SHA-512 verification. Retry the download.");
	}
}

export function createAntigravityInstallation({
	directory = path.join(/* turbopackIgnore: true */ ANTIGRAVITY_DIR, "runtime"),
	platform = process.platform,
	arch = process.arch,
	fetchManifest = (...args) => fetch(...args),
	download = (url) => fetch(url, { redirect: "error", cache: "no-store" }),
	extract = extractTar,
	binariesInUse = antigravityBinariesInUse,
}: RuntimeOptions = {}) {
	const target = antigravityPlatformTarget(platform, arch);
	const executable = platform === "win32" ? "agy.exe" : "antigravity";
	const pointer = path.join(/* turbopackIgnore: true */ directory, "current.json");
	let latestRelease: Release | null = null;
	let manifestRequest: Promise<Release> | null = null;
	let manifestCheckedAt = 0;
	let changing = false;

	function versionDirectory(version: string) { return path.join(/* turbopackIgnore: true */ directory, version); }
	function versionBinary(version: string) { return path.join(/* turbopackIgnore: true */ versionDirectory(version), executable); }

	function isExecutable(binary: string): boolean {
		try {
			if (!fs.lstatSync(/* turbopackIgnore: true */ binary).isFile()) return false;
			fs.accessSync(/* turbopackIgnore: true */ binary, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
			return true;
		} catch { return false; }
	}

	function currentRuntime(): { version: string; binary: string } | null {
		try {
			const current = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ pointer, "utf8"));
			if (!supportedVersion(current?.version) || current.executable !== executable) return null;
			const binary = versionBinary(current.version);
			return isExecutable(binary) ? { version: current.version, binary } : null;
		} catch { return null; }
	}

	async function fetchLatestRelease(): Promise<Release> {
		if (!target) throw new AntigravityRuntimeError("Google does not publish Antigravity for this platform.");
		if (!manifestRequest) {
			manifestRequest = (async () => {
				try {
					const response = await fetchManifest(`${MANIFEST_ROOT}${target}.json`, {
						signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store",
					});
					if (!response.ok) throw new Error("manifest unavailable");
					const release = parseRelease(await response.json());
					latestRelease = release;
					return release;
				} catch (error) {
					if (error instanceof AntigravityRuntimeError) throw error;
					throw new AntigravityRuntimeError("Could not check Google's Antigravity releases. Try again.");
				}
			})().finally(() => { manifestCheckedAt = Date.now(); manifestRequest = null; });
		}
		return manifestRequest;
	}

	async function checkLatestVersion(): Promise<void> {
		if (target && Date.now() - manifestCheckedAt >= 60_000) {
			await fetchLatestRelease().catch(() => undefined);
		}
	}

	function latestVersion(): string | null { return latestRelease?.version ?? null; }

	function prune(keep: string | null) {
		const leased = binariesInUse();
		const entries = fs.readdirSync(/* turbopackIgnore: true */ directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !parseVersion(entry.name) || entry.name === keep || leased.has(versionBinary(entry.name))) continue;
			fs.rmSync(versionDirectory(entry.name), { recursive: true, force: true });
		}
	}

	function beginChange() {
		if (changing) throw new AntigravityRuntimeError("An Antigravity runtime change is already in progress.");
		changing = true;
	}

	async function installRuntime(onProgress: Progress = () => undefined): Promise<void> {
		beginChange();
		let staging: string | undefined;
		try {
			onProgress("Checking for the latest version");
			const release = await fetchLatestRelease();
			const current = currentRuntime();
			if (current && !isNewerAntigravityVersion(release.version, current.version)) {
				prune(current.version);
				return;
			}

			fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true, mode: 0o700 });
			staging = fs.mkdtempSync(path.join(/* turbopackIgnore: true */ directory, ".staging-"));
			const artifact = path.join(/* turbopackIgnore: true */ staging, platform === "win32" ? "download.exe" : "download.tar.gz");
			const prepared = path.join(/* turbopackIgnore: true */ staging, "version");
			const binary = path.join(/* turbopackIgnore: true */ prepared, executable);
			await downloadRelease(release, artifact, download, onProgress);
			fs.mkdirSync(prepared, { mode: 0o700 });
			if (platform === "win32") {
				fs.renameSync(artifact, binary);
			} else {
				onProgress("Extracting");
				await extract(artifact, prepared);
			}
			if (!fs.lstatSync(binary, { throwIfNoEntry: false })?.isFile()) {
				throw new AntigravityRuntimeError("The Antigravity download did not contain the expected executable.");
			}
			fs.chmodSync(binary, 0o755);
			if (!isExecutable(binary)) throw new AntigravityRuntimeError("The downloaded Antigravity runtime is not executable.");

			const installed = versionBinary(release.version);
			const versionDir = versionDirectory(release.version);
			if (binariesInUse().has(installed)) {
				throw new AntigravityRuntimeError("This Antigravity runtime is in use. Wait for active requests to finish and retry.");
			}
			fs.rmSync(versionDir, { recursive: true, force: true });
			fs.renameSync(prepared, versionDir);
			writeFileAtomicSync(pointer, JSON.stringify({ version: release.version, executable }), { mode: 0o600 });
			prune(release.version);
		} finally {
			changing = false;
			if (staging) fs.rmSync(staging, { recursive: true, force: true });
		}
	}

	function removeRuntime(): void {
		beginChange();
		try {
			const current = currentRuntime();
			if (current && binariesInUse().has(current.binary)) {
				throw new AntigravityRuntimeError("The current Antigravity runtime is in use. Wait for active requests to finish before removing it.");
			}
			if (!fs.existsSync(/* turbopackIgnore: true */ directory)) return;
			fs.rmSync(/* turbopackIgnore: true */ pointer, { force: true });
			prune(null);
		} finally {
			changing = false;
		}
	}

	return { platformSupported: target !== null, fetchLatestRelease, checkLatestVersion, latestVersion, currentRuntime, installRuntime, removeRuntime };
}

export const antigravityInstallation = createAntigravityInstallation();
export const { fetchLatestRelease, currentRuntime, installRuntime, removeRuntime } = antigravityInstallation;
