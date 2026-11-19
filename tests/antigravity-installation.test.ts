import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { acquireAntigravityBinary } from "../src/agent/antigravity/runtime-source.ts";
import { antigravityPlatformTarget, createAntigravityInstallation } from "../src/server/antigravity/installation.ts";

const payload = "synthetic Antigravity artifact";
const release = {
	version: "1.5.12",
	url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12-test/cli.tar.gz",
	sha512: createHash("sha512").update(payload).digest("hex"),
};

test("Google manifest targets match the supported platforms", () => {
	assert.equal(antigravityPlatformTarget("darwin", "arm64"), "darwin_arm64");
	assert.equal(antigravityPlatformTarget("darwin", "x64"), "darwin_amd64");
	assert.equal(antigravityPlatformTarget("linux", "arm64"), "linux_arm64");
	assert.equal(antigravityPlatformTarget("linux", "x64"), "linux_amd64");
	assert.equal(antigravityPlatformTarget("win32", "arm64"), "windows_arm64");
	assert.equal(antigravityPlatformTarget("win32", "x64"), "windows_amd64");
	assert.equal(antigravityPlatformTarget("linux", "ia32"), null);
	assert.equal(antigravityPlatformTarget("freebsd", "x64"), null);
});

test("the release fetch uses the official manifest URL, a deadline, and no redirects", async () => {
	const installation = createAntigravityInstallation({
		platform: "darwin", arch: "arm64",
		fetchManifest: async (url, options) => {
			assert.equal(url, "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json");
			assert.equal(options?.redirect, "error");
			assert.ok(options?.signal instanceof AbortSignal);
			return Response.json({ ...release, sha512: release.sha512.toUpperCase() });
		},
	});
	assert.deepEqual(await installation.fetchLatestRelease(), release);
});

for (const invalid of [
	null,
	{ ...release, version: "1.4.99" },
	{ ...release, version: "1.5.0-rc.1" },
	{ ...release, version: "1.05.1" },
	{ ...release, version: "../1.5.12" },
	{ ...release, sha512: "f".repeat(127) },
	{ ...release, sha512: "x".repeat(128) },
	{ ...release, url: "http://storage.googleapis.com/antigravity-public/antigravity-cli/agy" },
	{ ...release, url: "https://storage.googleapis.com.attacker.invalid/antigravity-public/antigravity-cli/agy" },
	{ ...release, url: "https://storage.googleapis.com/other-bucket/agy" },
	{ ...release, url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/%2e%2e/agy" },
]) test(`invalid Antigravity manifest ${JSON.stringify(invalid)} is rejected`, async () => {
	const installation = createAntigravityInstallation({
		platform: "linux", arch: "x64",
		fetchManifest: async () => Response.json(invalid),
	});
	await assert.rejects(installation.fetchLatestRelease(), /invalid Antigravity release manifest/);
});

function fixture(t: TestContext, overrides: Parameters<typeof createAntigravityInstallation>[0] = {}) {
	const directory = fs.mkdtempSync(path.join(tmpdir(), "lh-antigravity-runtime-test-"));
	t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
	let manifest = release;
	const install = createAntigravityInstallation({
		directory, platform: "linux", arch: "x64",
		fetchManifest: async () => Response.json(manifest),
		download: async () => new Response(payload, { headers: { "Content-Length": String(Buffer.byteLength(payload)) } }),
		extract: async (archive, output) => {
			assert.equal(fs.readFileSync(archive, "utf8"), payload);
			fs.writeFileSync(path.join(output, "antigravity"), "fake executable");
		},
		...overrides,
	});
	return { directory, install, setRelease: (next: typeof release) => { manifest = next; } };
}

test("verified bytes are installed with an atomic pointer and progress updates", async (t) => {
	const { directory, install } = fixture(t);
	assert.equal(install.currentRuntime(), null);
	const progress: string[] = [];
	await install.installRuntime((message) => { progress.push(message); });
	const binary = path.join(directory, release.version, "antigravity");
	assert.deepEqual(install.currentRuntime(), { version: release.version, binary });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "current.json"), "utf8")), {
		version: release.version, executable: "antigravity",
	});
	fs.accessSync(binary, fs.constants.X_OK);
	assert.deepEqual(progress, ["Checking for the latest version", "Downloading", "Downloading 100%", "Verifying", "Extracting"]);
	assert.deepEqual(fs.readdirSync(directory).sort(), [release.version, "current.json"]);
	const pointer = path.join(directory, "current.json");
	fs.writeFileSync(pointer, JSON.stringify({ version: release.version, executable: "/outside/antigravity" }));
	assert.equal(install.currentRuntime(), null);
	fs.writeFileSync(pointer, JSON.stringify({ version: release.version, executable: "antigravity" }));
	fs.unlinkSync(binary);
	assert.equal(install.currentRuntime(), null);
});

test("a wrong SHA-512 never extracts or replaces the active runtime", async (t) => {
	let extractions = 0;
	const { directory, install, setRelease } = fixture(t, {
		extract: async (_archive, output) => {
			extractions++;
			fs.writeFileSync(path.join(output, "antigravity"), "fake executable");
		},
	});
	await install.installRuntime();
	const active = install.currentRuntime();
	setRelease({ ...release, version: "1.6.0", sha512: "a".repeat(128) });
	await assert.rejects(install.installRuntime(), /failed its SHA-512 verification/);
	assert.deepEqual(install.currentRuntime(), active);
	assert.equal(extractions, 1);
	assert.deepEqual(fs.readdirSync(directory).sort(), [release.version, "current.json"]);
});

test("Windows installs the raw verified executable without invoking tar", async (t) => {
	const { directory, install } = fixture(t, {
		platform: "win32",
		extract: async () => assert.fail("Windows must not extract a tar archive"),
	});
	await install.installRuntime();
	const binary = path.join(directory, release.version, "agy.exe");
	assert.deepEqual(install.currentRuntime(), { version: release.version, binary });
	assert.equal(fs.readFileSync(binary, "utf8"), payload);
});

test("an update keeps leased versions, does not downgrade, and removal refuses an active lease", async (t) => {
	const { directory, install, setRelease } = fixture(t);
	await install.installRuntime();
	const first = install.currentRuntime()!;
	const releaseFirst = acquireAntigravityBinary(first.binary);
	t.after(releaseFirst);

	setRelease({ ...release, version: "1.10.0" });
	await install.installRuntime();
	const second = install.currentRuntime()!;
	assert.equal(second.version, "1.10.0");
	assert.equal(fs.existsSync(first.binary), true);
	setRelease({ ...release, version: "1.9.0" });
	await install.installRuntime();
	assert.deepEqual(install.currentRuntime(), second);

	const releaseSecond = acquireAntigravityBinary(second.binary);
	t.after(releaseSecond);
	assert.throws(() => install.removeRuntime(), /current Antigravity runtime is in use/);
	assert.deepEqual(install.currentRuntime(), second);
	releaseSecond();
	install.removeRuntime();
	assert.equal(install.currentRuntime(), null);
	assert.equal(fs.existsSync(second.binary), false);
	assert.equal(fs.existsSync(first.binary), true);
	releaseFirst();
	install.removeRuntime();
	assert.deepEqual(fs.readdirSync(directory), []);
});

test("runtime changes are serialized while a download is underway", async (t) => {
	let finishDownload!: (response: Response) => void;
	const download = new Promise<Response>((resolve) => { finishDownload = resolve; });
	const { install } = fixture(t, { download: () => download });
	const first = install.installRuntime();
	await assert.rejects(install.installRuntime(), /already in progress/);
	assert.throws(() => install.removeRuntime(), /already in progress/);
	finishDownload(new Response(payload));
	await first;
	assert.ok(install.currentRuntime());
});
