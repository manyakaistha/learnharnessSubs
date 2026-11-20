import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-sources-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { MAX_IMPORT_BYTES } = await import("../lib/notes-import-limits.ts");
const { applyCourseAction, emptyCourseState } = await import("../src/core/courses.ts");
const { subscribe } = await import("../src/core/events.ts");
const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");
const { createExtractionPipeline, NotesImportError } = await import("../src/agent/subagents/extraction.ts");
const { stores } = await import("../src/server/stores.ts");
const {
	courseFileSourceId,
	courseFileStatuses,
	courseScanning,
	setCourseExtractorForTests,
	startCourseScan,
	waitForCourseScanForTests,
} = await import("../src/server/course-sources.ts");
const { COURSES_FILE, SOURCE_ORGANIZATION_FILE } = await import("../config.ts");

let seq = 0;
const fresh = () => ({ id: `id_${++seq}`, at: "2026-11-20T00:00:00Z" });
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function writeText(filePath: string, content: string): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
	return filePath;
}

function createCourseWithFolder(name: string, folderPath: string) {
	let state = stores.courseStore.read();
	const courseId = `crs_${++seq}`;
	const folderId = `fld_${++seq}`;
	state = applyCourseAction(state, { action: "create", name }, { id: courseId, at: "2026-11-20T00:00:00Z" });
	state = applyCourseAction(state, { action: "add-folder", id: courseId, path: folderPath }, { id: folderId, at: "2026-11-20T00:00:00Z" });
	stores.courseStore.write(state);
	return { courseId, folderId };
}

beforeEach(() => {
	setCourseExtractorForTests(null);
	if (fs.existsSync(COURSES_FILE)) fs.unlinkSync(COURSES_FILE);
	if (fs.existsSync(SOURCE_ORGANIZATION_FILE)) fs.unlinkSync(SOURCE_ORGANIZATION_FILE);
	stores.courseStore.write(emptyCourseState());
});

it("initial scan extracts supported files sequentially, skips unsupported/dot-dirs/symlink loops, flags oversize, writes membership/folderFiles/sourceOrganization", async () => {
	const folderDir = fs.mkdtempSync(path.join(root, "CV-"));
	const f1 = writeText(path.join(folderDir, "a_intro.md"), "# Intro\nVectors and matrices.");
	const f2 = writeText(path.join(folderDir, "sub", "b_notes.txt"), "Eigenvalues are roots of the characteristic polynomial.");
	writeText(path.join(folderDir, "ignored.png"), "not an image");
	writeText(path.join(folderDir, "meta.json"), "{}");
	writeText(path.join(folderDir, ".obsidian", "workspace.md"), "hidden obsidian");
	writeText(path.join(folderDir, ".git", "commit.md"), "hidden git");
	writeText(path.join(folderDir, ".trash", "deleted.md"), "hidden trash");
	fs.symlinkSync(folderDir, path.join(folderDir, "sub", "loop"), "dir");

	const oversizeFile = writeText(path.join(folderDir, "z_huge.md"), "");
	fs.truncateSync(oversizeFile, MAX_IMPORT_BYTES + 1);

	const { courseId, folderId } = createCourseWithFolder("CV", folderDir);
	const folderBase = path.basename(folderDir);

	let active = 0;
	let maxActive = 0;
	const seenCalls: Array<{ sourceId: string; filePath: string; text: string }> = [];
	const events: string[] = [];
	const unsub = subscribe((ev) => events.push(ev.type));

	setCourseExtractorForTests(async (input) => {
		active++;
		maxActive = Math.max(maxActive, active);
		seenCalls.push(input);
		await new Promise((r) => setTimeout(r, 15));
		active--;
		return { nodes: 1, chains: 0 };
	});

	try {
		startCourseScan(courseId);
		assert.equal(courseScanning(courseId), true);
		// A second request while running queues one follow-up pass (which
		// finds every file unchanged and extracts nothing more).
		startCourseScan(courseId);

		await waitForCourseScanForTests(courseId);
		while (courseScanning(courseId)) await waitForCourseScanForTests(courseId);
	} finally {
		unsub();
	}

	assert.equal(courseScanning(courseId), false);
	assert.equal(maxActive, 1, "files in a course must be extracted sequentially");
	assert.equal(seenCalls.length, 2);
	assert.deepEqual(
		seenCalls.map((c) => ({ sourceId: c.sourceId, filePath: c.filePath })),
		[
			{ sourceId: courseFileSourceId(f1), filePath: `${folderBase}/a_intro.md` },
			{ sourceId: courseFileSourceId(f2), filePath: `${folderBase}/sub/b_notes.txt` },
		],
	);
	assert.equal(seenCalls[0]!.text, "# Intro\nVectors and matrices.");

	const statuses = courseFileStatuses(courseId);
	assert.equal(statuses.length, 3);
	assert.deepEqual(statuses.find((s) => s.path === f1), { path: f1, folderId, state: "extracted" });
	assert.deepEqual(statuses.find((s) => s.path === f2), { path: f2, folderId, state: "extracted" });
	const hugeStatus = statuses.find((s) => s.path === oversizeFile);
	assert.equal(hugeStatus?.state, "failed");
	assert.match(hugeStatus?.error ?? "", /too large/i);

	const courseState = stores.courseStore.read();
	assert.equal(courseState.membership[courseFileSourceId(f1)], courseId);
	assert.equal(courseState.membership[courseFileSourceId(f2)], courseId);
	assert.equal(courseState.membership[courseFileSourceId(oversizeFile)], undefined);
	assert.equal(courseState.folderFiles[f1]?.sha256, sha256(fs.readFileSync(f1)));
	assert.equal(courseState.folderFiles[f2]?.sourceId, courseFileSourceId(f2));
	assert.equal(courseState.folderFiles[oversizeFile], undefined);

	const org = stores.sourceOrganizationStore.read();
	const rootFolder = org.folders.find((f) => f.importPath === folderBase);
	const subFolder = org.folders.find((f) => f.importPath === `${folderBase}/sub`);
	assert.ok(rootFolder);
	assert.ok(subFolder);
	assert.equal(subFolder.parentId, rootFolder.id);
	assert.equal(org.placements[courseFileSourceId(f1)]?.folderId, rootFolder.id);
	assert.equal(org.placements[courseFileSourceId(f2)]?.folderId, subFolder.id);
	assert.ok(events.includes("courses-changed"));
});

it("rescan skips unchanged files, re-extracts changed files, and stops listing deleted files while keeping knowledge", async () => {
	const folderDir = fs.mkdtempSync(path.join(root, "DL-"));
	const f1 = writeText(path.join(folderDir, "week1.md"), "Perceptron v1");
	const f2 = writeText(path.join(folderDir, "week2.md"), "Backprop v1");
	const { courseId } = createCourseWithFolder("DL", folderDir);

	const extracted: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => {
		extracted.push(filePath);
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);
	assert.equal(extracted.length, 2);

	// Rescan with no changes: skips both.
	extracted.length = 0;
	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);
	assert.equal(extracted.length, 0);
	assert.equal(courseFileStatuses(courseId).length, 2);
	assert.ok(courseFileStatuses(courseId).every((s) => s.state === "extracted"));

	// Modify f1, delete f2, add f3.
	writeText(f1, "Perceptron v2");
	fs.unlinkSync(f2);
	const f3 = writeText(path.join(folderDir, "week3.rst"), "Transformers");

	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);

	const folderBase = path.basename(folderDir);
	assert.deepEqual(extracted, [`${folderBase}/week1.md`, `${folderBase}/week3.rst`]);
	const statuses = courseFileStatuses(courseId);
	assert.deepEqual(statuses.map((s) => s.path).sort(), [f1, f3].sort());
	assert.ok(statuses.every((s) => s.state === "extracted"));

	// Deleted file's knowledge/membership stays in courseStore.
	const state = stores.courseStore.read();
	assert.equal(state.membership[courseFileSourceId(f2)], courseId);
	assert.equal(state.folderFiles[f1]?.sha256, sha256(Buffer.from("Perceptron v2", "utf8")));
});

it("retries busy gate and continues past missing-model or extraction failures", async () => {
	const folderDir = fs.mkdtempSync(path.join(root, "Robotics-"));
	const f1 = writeText(path.join(folderDir, "01_busy_then_ok.md"), "Kinematics");
	const f2 = writeText(path.join(folderDir, "02_missing_models.md"), "Dynamics");
	const f3 = writeText(path.join(folderDir, "03_ok.md"), "Control");
	const { courseId } = createCourseWithFolder("Robotics", folderDir);

	let f1Attempts = 0;
	setCourseExtractorForTests(async ({ filePath }) => {
		if (filePath.endsWith("01_busy_then_ok.md")) {
			f1Attempts++;
			if (f1Attempts === 1) throw new NotesImportError("busy", { nodes: 0, chains: 0 }, "Busy");
			return { nodes: 1, chains: 0 };
		}
		if (filePath.endsWith("02_missing_models.md")) {
			throw new ModelsNotConfiguredError(["cheap"]);
		}
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);

	assert.equal(f1Attempts, 2, "busy error should be retried rather than failing");
	const statuses = courseFileStatuses(courseId);
	assert.equal(statuses.find((s) => s.path === f1)?.state, "extracted");
	const f2Status = statuses.find((s) => s.path === f2);
	assert.equal(f2Status?.state, "failed");
	assert.ok(f2Status?.error && f2Status.error.length > 0);
	assert.equal(statuses.find((s) => s.path === f3)?.state, "extracted");

	const state = stores.courseStore.read();
	assert.equal(state.membership[courseFileSourceId(f1)], courseId);
	assert.equal(state.membership[courseFileSourceId(f2)], undefined);
	assert.equal(state.membership[courseFileSourceId(f3)], courseId);
});

it("stops processing and skips membership writes when course is deleted mid-scan", async () => {
	const folderDir = fs.mkdtempSync(path.join(root, "DeletedCourse-"));
	const f1 = writeText(path.join(folderDir, "01_first.md"), "First");
	const f2 = writeText(path.join(folderDir, "02_second.md"), "Second");
	const { courseId } = createCourseWithFolder("TempCourse", folderDir);

	const extracted: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => {
		extracted.push(filePath);
		const current = stores.courseStore.read();
		const next = applyCourseAction(current, { action: "delete", id: courseId, mode: "ungroup" }, fresh());
		stores.courseStore.write(next);
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);

	assert.equal(extracted.length, 1, "second file must not be processed after course deletion");
	assert.equal(courseScanning(courseId), false);
	assert.deepEqual(courseFileStatuses(courseId), []);

	const state = stores.courseStore.read();
	assert.equal(state.courses.some((c) => c.id === courseId), false);
	assert.equal(state.membership[courseFileSourceId(f1)], undefined);
	assert.equal(state.membership[courseFileSourceId(f2)], undefined);
	assert.equal(state.folderFiles[f1], undefined);
});

it("stops processing folder files when folder is removed mid-scan", async () => {
	const folderDir = fs.mkdtempSync(path.join(root, "RemovedFolder-"));
	const f1 = writeText(path.join(folderDir, "01_first.md"), "First");
	const f2 = writeText(path.join(folderDir, "02_second.md"), "Second");
	const { courseId, folderId } = createCourseWithFolder("FolderCourse", folderDir);

	const extracted: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => {
		extracted.push(filePath);
		const current = stores.courseStore.read();
		const next = applyCourseAction(current, { action: "remove-folder", id: courseId, folderId }, fresh());
		stores.courseStore.write(next);
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);

	assert.equal(extracted.length, 1);
	assert.deepEqual(courseFileStatuses(courseId), []);
	const state = stores.courseStore.read();
	assert.equal(state.membership[courseFileSourceId(f1)], undefined);
	assert.equal(state.membership[courseFileSourceId(f2)], undefined);
	assert.equal(state.folderFiles[f1], undefined);
});

it("extraction.importNotes honors optional sourceId override while preserving filePath label", async () => {
	const fakeEngine = {
		async run() {
			throw new Error("should not be called");
		},
	};
	void fakeEngine;
	// Verify empty/whitespace text passes readiness gate and records overridden sourceId + readable filePath.
	const mockEngine = (() => ({})) as unknown as Parameters<typeof createExtractionPipeline>[0]["extractor"];
	const pipeline = createExtractionPipeline({
		chatStore: stores.chatStore,
		graphStore: stores.graphStore,
		extractor: mockEngine,
		auditor: mockEngine,
	});
	const customId = courseFileSourceId("/abs/path/Course/week1.md");
	const stats = await pipeline.importNotes({
		sourceId: customId,
		filePath: "Course/week1.md",
		text: "   ",
	});
	assert.deepEqual(stats, { nodes: 0, chains: 0 });
	const source = stores.graphStore.readSources().find((s) => s.id === customId);
	assert.ok(source, "source record should be stored under overridden sourceId");
	assert.equal(source.filePath, "Course/week1.md");
});

it("never follows symlinks outside the folder and dedupes links to one file", async () => {
	const outside = writeText(path.join(root, "outside-secret", "secret.md"), "# secret");
	const folder = path.join(root, "link-course");
	writeText(path.join(folder, "real.md"), "# real");
	fs.symlinkSync(outside, path.join(folder, "escape.md"));
	fs.symlinkSync(path.dirname(outside), path.join(folder, "escape-dir"));
	fs.symlinkSync(path.join(folder, "real.md"), path.join(folder, "alias.md"));
	const seen: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => { seen.push(filePath); return { nodes: 1, chains: 0 }; });
	const { courseId } = createCourseWithFolder("Links", folder);
	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);
	assert.deepEqual(seen, ["link-course/alias.md"], "one extraction for the two names of real.md; nothing outside");
});

it("a scan requested while one runs triggers exactly one follow-up pass", async () => {
	const folder = path.join(root, "pending-course");
	writeText(path.join(folder, "a.md"), "# a");
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const seen: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => { seen.push(filePath); if (seen.length === 1) await gate; return { nodes: 1, chains: 0 }; });
	const { courseId } = createCourseWithFolder("Pending", folder);
	startCourseScan(courseId);
	await new Promise((r) => setTimeout(r, 50));
	writeText(path.join(folder, "b.md"), "# b");
	startCourseScan(courseId);
	startCourseScan(courseId);
	release();
	await waitForCourseScanForTests(courseId);
	await new Promise((r) => setTimeout(r, 20));
	await waitForCourseScanForTests(courseId);
	assert.deepEqual(seen, ["pending-course/a.md", "pending-course/b.md"]);
	assert.equal(courseScanning(courseId), false);
});
