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
	forgetCourseStatuses,
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

it("excluded files report state 'excluded' even when not scanning and are skipped by scans", async () => {
	const folder = path.join(root, "excluded-course");
	const f1 = writeText(path.join(folder, "keep.md"), "# keep");
	const f2 = writeText(path.join(folder, "skip.md"), "# skip v1");
	const { courseId, folderId } = createCourseWithFolder("Excl", folder);

	const state = stores.courseStore.read();
	state.folderFiles[f1] = {
		courseId,
		folderId,
		sourceId: courseFileSourceId(f1),
		sha256: sha256(fs.readFileSync(f1)),
		extractedAt: "2026-11-20T00:00:00Z",
	};
	state.folderFiles[f2] = {
		courseId,
		folderId,
		sourceId: courseFileSourceId(f2),
		sha256: sha256(fs.readFileSync(f2)),
		extractedAt: "2026-11-20T00:00:00Z",
		excluded: true,
	};
	stores.courseStore.write(state);
	forgetCourseStatuses(courseId);

	// Before any scan (uncached fallback), excluded is reported accurately
	const uncached = courseFileStatuses(courseId);
	assert.deepEqual(uncached.find((s) => s.path === f1), { path: f1, folderId, state: "extracted" });
	assert.deepEqual(uncached.find((s) => s.path === f2), { path: f2, folderId, state: "excluded" });

	// Scan skips f2 even after editing it on disk
	writeText(f2, "# skip v2");
	const seen: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => { seen.push(filePath); return { nodes: 1, chains: 0 }; });
	startCourseScan(courseId);
	await waitForCourseScanForTests(courseId);
	assert.deepEqual(seen, []);
	assert.deepEqual(courseFileStatuses(courseId).find((s) => s.path === f2), { path: f2, folderId, state: "excluded" });
});

it("a file excluded while the scan runs is skipped, and an exclusion recorded mid-extraction is never overwritten", async () => {
	const folder = path.join(root, "exclude-mid-scan");
	const a = writeText(path.join(folder, "a.md"), "# a");
	const b = writeText(path.join(folder, "b.md"), "# b");
	const c = writeText(path.join(folder, "c.md"), "# c");
	const { courseId, folderId } = createCourseWithFolder("MidScan", folder);
	const exclude = (file: string) => {
		const state = stores.courseStore.read();
		state.folderFiles[file] = { courseId, folderId, sourceId: courseFileSourceId(file), sha256: "x", extractedAt: "t", excluded: true };
		stores.courseStore.write(state);
	};
	const seen: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => {
		seen.push(filePath);
		if (filePath.endsWith("a.md")) exclude(b); // b deleted while a extracts
		if (filePath.endsWith("c.md")) exclude(c); // c deleted while c itself extracts
		return { nodes: 1, chains: 0 };
	});
	startCourseScan(courseId);
	while (courseScanning(courseId)) await waitForCourseScanForTests(courseId);
	assert.deepEqual(seen.map((p) => path.basename(p)), ["a.md", "c.md"], "b is never extracted");
	const state = stores.courseStore.read();
	assert.equal(state.folderFiles[b]?.excluded, true);
	assert.equal(state.folderFiles[c]?.excluded, true, "c's exclusion survives its own extraction commit");
	assert.equal(state.folderFiles[a]?.excluded, undefined);
	const statuses = Object.fromEntries(courseFileStatuses(courseId).map((s) => [path.basename(s.path), s.state]));
	assert.deepEqual(statuses, { "a.md": "extracted", "b.md": "excluded", "c.md": "excluded" });
});

it("assigns membership only on first discovery so moved or unassigned sources do not revert on re-extraction", async () => {
	const folder = path.join(root, "moved-sources");
	const fMoveB = writeText(path.join(folder, "move_to_b.md"), "# Move B v1");
	const fNoCourse = writeText(path.join(folder, "move_to_none.md"), "# Move None v1");
	const fDuring = writeText(path.join(folder, "move_during.md"), "# Move During v1");
	const fFirstDuring = writeText(path.join(folder, "first_during.md"), "# First During v1");

	const { courseId: courseA } = createCourseWithFolder("CourseA", folder);
	let state = stores.courseStore.read();
	state = applyCourseAction(state, { action: "create", name: "CourseB" }, { id: "crs_b_move", at: "2026-11-20T00:00:00Z" });
	stores.courseStore.write(state);
	const courseB = "crs_b_move";

	setCourseExtractorForTests(async ({ filePath }) => {
		if (filePath.endsWith("first_during.md")) {
			const cur = stores.courseStore.read();
			stores.courseStore.write(applyCourseAction(cur, {
				action: "assign",
				sourceId: courseFileSourceId(fFirstDuring),
				courseId: courseB,
			}, fresh()));
		}
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseA);
	while (courseScanning(courseA)) await waitForCourseScanForTests(courseA);

	const srcMoveB = courseFileSourceId(fMoveB);
	const srcNoCourse = courseFileSourceId(fNoCourse);
	const srcDuring = courseFileSourceId(fDuring);
	const srcFirstDuring = courseFileSourceId(fFirstDuring);

	state = stores.courseStore.read();
	assert.equal(state.membership[srcMoveB], courseA);
	assert.equal(state.membership[srcNoCourse], courseA);
	assert.equal(state.membership[srcDuring], courseA);
	assert.equal(state.membership[srcFirstDuring], courseB, "membership assigned during first discovery is kept");

	// Move fMoveB -> CourseB and fNoCourse -> No course BEFORE modifying files & rescanning A
	state = applyCourseAction(state, { action: "assign", sourceId: srcMoveB, courseId: courseB }, fresh());
	state = applyCourseAction(state, { action: "assign", sourceId: srcNoCourse, courseId: null }, fresh());
	stores.courseStore.write(state);

	writeText(fMoveB, "# Move B v2");
	writeText(fNoCourse, "# Move None v2");
	writeText(fDuring, "# Move During v2");

	// Move fDuring -> No course DURING re-extraction
	setCourseExtractorForTests(async ({ filePath }) => {
		if (filePath.endsWith("move_during.md")) {
			const cur = stores.courseStore.read();
			stores.courseStore.write(applyCourseAction(cur, { action: "assign", sourceId: srcDuring, courseId: null }, fresh()));
		}
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseA);
	while (courseScanning(courseA)) await waitForCourseScanForTests(courseA);

	const finalState = stores.courseStore.read();
	assert.equal(finalState.membership[srcMoveB], courseB, "A->B move survives file edit and rescan");
	assert.equal(finalState.membership[srcNoCourse], undefined, "move to No course survives file edit and rescan");
	assert.equal(finalState.membership[srcDuring], undefined, "move during re-extraction is kept");
});

it("scans an attached folder whose own path is hidden while skipping dot-prefixed entries during traversal", async () => {
	const hiddenFolder = path.join(root, ".hidden-vault");
	const visible = writeText(path.join(hiddenFolder, "lecture.md"), "# Lecture");
	const nested = writeText(path.join(hiddenFolder, "sub", "details.md"), "# Details");
	writeText(path.join(hiddenFolder, ".hidden.md"), "skip dot file");
	writeText(path.join(hiddenFolder, ".obsidian", "app.md"), "skip obsidian");
	writeText(path.join(hiddenFolder, ".hidden-sub", "note.md"), "skip dot dir");

	const { courseId } = createCourseWithFolder("HiddenRoot", hiddenFolder);
	const seen: string[] = [];
	setCourseExtractorForTests(async ({ filePath }) => {
		seen.push(filePath);
		return { nodes: 1, chains: 0 };
	});

	startCourseScan(courseId);
	while (courseScanning(courseId)) await waitForCourseScanForTests(courseId);

	assert.deepEqual(seen, [".hidden-vault/lecture.md", ".hidden-vault/sub/details.md"]);
	assert.deepEqual(courseFileStatuses(courseId).map((s) => s.path).sort(), [visible, nested].sort());
});

it("catches scan-level store failures, marks pending files failed, emits courses-changed, and still runs queued follow-up rescans without unhandled rejections", async (t) => {
	const folder = path.join(root, "scan-level-failure");
	const f1 = writeText(path.join(folder, "01_first.md"), "# First");
	const f2 = writeText(path.join(folder, "02_second.md"), "# Second");
	const { courseId, folderId } = createCourseWithFolder("ScanFailure", folder);

	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	const logged: unknown[][] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });

	const events: string[] = [];
	const unsub = subscribe((ev) => events.push(ev.type));
	const origRead = stores.courseStore.read.bind(stores.courseStore);
	const origWrite = stores.courseStore.write.bind(stores.courseStore);
	let throwOnNextLoopRead = false;

	try {
		// 1) Mid-queue scan-level failure after 01_first.md commits and while 02_second.md is queued
		t.mock.method(stores.courseStore, "write", (nextState: Parameters<typeof origWrite>[0]) => {
			origWrite(nextState);
			throwOnNextLoopRead = true;
		});
		t.mock.method(stores.courseStore, "read", () => {
			if (throwOnNextLoopRead) {
				throwOnNextLoopRead = false;
				throw new Error("Simulated mid-scan store read failure");
			}
			return origRead();
		});

		setCourseExtractorForTests(async () => ({ nodes: 1, chains: 0 }));

		startCourseScan(courseId);
		while (courseScanning(courseId)) await waitForCourseScanForTests(courseId);

		assert.equal(courseScanning(courseId), false);
		assert.equal(rejections.length, 0, "must not produce unhandledRejection");
		assert.ok(logged.length >= 1, "scan-level error is logged");
		assert.ok(events.includes("courses-changed"));

		const statuses = courseFileStatuses(courseId);
		assert.equal(statuses.find((s) => s.path === f1)?.state, "extracted");
		assert.deepEqual(statuses.find((s) => s.path === f2), {
			path: f2,
			folderId,
			state: "failed",
			error: "Simulated mid-scan store read failure",
		});

		// 2) Pre-queue scan-level failure while a follow-up rescan is queued: finally cleanup + follow-up scan recover
		events.length = 0;
		let throwOnceDuringScan = false;
		let queuedFollowup!: () => void;
		const followupQueued = new Promise<void>((r) => { queuedFollowup = r; });
		let readCount = 0;
		t.mock.restoreAll();
		t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
		t.mock.method(stores.courseStore, "read", () => {
			readCount++;
			// Start throwing after startCourseScan's own read and first read in runCourseScan, while queueing follow-up
			if (throwOnceDuringScan && readCount === 2) {
				throwOnceDuringScan = false;
				startCourseScan(courseId);
				queuedFollowup();
				throw new Error("Simulated discovery-phase store read failure");
			}
			return origRead();
		});
		setCourseExtractorForTests(async () => ({ nodes: 1, chains: 0 }));

		throwOnceDuringScan = true;
		readCount = 0;
		startCourseScan(courseId);
		await followupQueued;
		while (courseScanning(courseId)) await waitForCourseScanForTests(courseId);

		assert.equal(courseScanning(courseId), false);
		assert.equal(rejections.length, 0);
		assert.ok(events.includes("courses-changed"));
		const recovered = courseFileStatuses(courseId);
		assert.equal(recovered.find((s) => s.path === f1)?.state, "extracted");
		assert.equal(recovered.find((s) => s.path === f2)?.state, "extracted");
	} finally {
		unsub();
		t.mock.restoreAll();
		process.off("unhandledRejection", onRejection);
	}
});
