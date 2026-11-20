/** Course source folders: scan, extract new/changed files, report status. */
import { createHash, randomUUID } from "node:crypto";
import fsSync, { type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES } from "../../lib/notes-import-limits.ts";
import { NotesImportError } from "../agent/subagents/extraction.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import type { CourseFileStatus, CourseFolder, CourseState } from "../core/contracts/courses.ts";
import { emit } from "../core/events.ts";
import { placeImportedSource } from "../core/source-organization.ts";
import { isWithin } from "../agent/tools/file-access.ts";
import { protectedSourceChecker } from "../agent/tools/fs-shared.ts";
import { extraction } from "./chat-handler.ts";
import { stores } from "./stores.ts";

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const BUSY_RETRY_DELAY_MS = 50;
const BUSY_MAX_WAIT_MS = 120_000;

export type CourseExtractor = (input: { sourceId: string; filePath: string; text: string }) => Promise<unknown>;

interface CourseSourcesRuntime {
	activeScans: Map<string, Promise<void>>;
	/** A scan requested while one runs: run one more pass when it ends. */
	pendingScans: Set<string>;
	statuses: Map<string, CourseFileStatus[]>;
	extractorOverride: CourseExtractor | null;
}

function runtime(): CourseSourcesRuntime {
	const g = globalThis as typeof globalThis & { __lhCourseSources?: CourseSourcesRuntime };
	return (g.__lhCourseSources ??= {
		activeScans: new Map(),
		pendingScans: new Set(),
		statuses: new Map(),
		extractorOverride: null,
	});
}

/** Test seam to replace `extraction.importNotes` without calling real models. */
export function setCourseExtractorForTests(extractor: CourseExtractor | null): void {
	runtime().extractorOverride = extractor;
}

/** Test helper to await an active scan pass deterministically without polling. */
export async function waitForCourseScanForTests(courseId: string): Promise<void> {
	await runtime().activeScans.get(courseId);
}

/** Deterministic source id for a course file on disk. */
export function courseFileSourceId(absolutePath: string): string {
	return `src_${createHash("sha256").update(`course:${path.resolve(absolutePath)}`).digest("hex").slice(0, 12)}`;
}

/** Readable relative label `<folder basename>/<relative path>` (POSIX slashes). */
function courseFileDisplayPath(folderPath: string, absolutePath: string): string {
	const resolvedFolder = path.resolve(folderPath);
	const folderBase = path.basename(resolvedFolder) || "Course";
	const rel = path.relative(resolvedFolder, path.resolve(absolutePath)).split(path.sep).join("/");
	return rel ? `${folderBase}/${rel}` : folderBase;
}

function oversizeMessage(): string {
	return `File is too large (max ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB).`;
}

async function decodeNotesBytes(bytes: Uint8Array): Promise<{ kind: "notes"; text: string } | { kind: "refused"; error: string }> {
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
		if (bytes.subarray(0, 8192).includes(0)) return { kind: "refused", error: "This file isn't plain text." };
		return { kind: "notes", text: new TextDecoder().decode(bytes) };
	}
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			return { kind: "notes", text };
		}
	}
}

interface DiscoveredFile {
	absPath: string;
	folder: CourseFolder;
	size: number;
}

async function discoverCourseFiles(folders: readonly CourseFolder[]): Promise<DiscoveredFile[]> {
	const discovered: DiscoveredFile[] = [];
	// Dedupe by CANONICAL path: two links to one file extract once.
	const seenFiles = new Set<string>();

	for (const folder of folders) {
		let realRoot: string;
		try { realRoot = await fs.realpath(/* turbopackIgnore: true */ path.resolve(folder.path)); }
		catch { continue; }
		// The same named + canonical denials the file tools apply (a home
		// location like ~/.ssh may itself be a symlink into this folder).
		const isProtected = protectedSourceChecker();
		if (isProtected(realRoot)) continue;
		const visitedDirs = new Set<string>();
		// Same containment the agent's file tools enforce: a symlink may not
		// lead outside the attached folder or into credential locations.
		const allowed = (lexical: string, real: string) =>
			isWithin(real, realRoot) && !isProtected(real) && !isProtected(lexical);

		const walk = async (dir: string): Promise<void> => {
			let realDir: string;
			try {
				realDir = await fs.realpath(/* turbopackIgnore: true */ dir);
				const st = await fs.stat(/* turbopackIgnore: true */ realDir);
				if (!st.isDirectory()) return;
			} catch {
				return;
			}
			if (!allowed(dir, realDir) || visitedDirs.has(realDir)) return;
			visitedDirs.add(realDir);

			let entries: Dirent[];
			try {
				entries = await fs.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true });
			} catch {
				return;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));

			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const fullPath = path.resolve(dir, entry.name);
				if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
				let real: string;
				let st: Stats;
				try {
					real = await fs.realpath(/* turbopackIgnore: true */ fullPath);
					st = await fs.stat(/* turbopackIgnore: true */ real);
				} catch {
					continue;
				}
				if (!allowed(fullPath, real)) continue;
				if (st.isDirectory()) await walk(fullPath);
				else if (st.isFile() && IMPORT_EXTENSIONS.test(entry.name) && !seenFiles.has(real)) {
					seenFiles.add(real);
					discovered.push({ absPath: fullPath, folder, size: st.size });
				}
			}
		};

		await walk(path.resolve(folder.path));
	}
	return discovered;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isCourseActive(courseId: string, folderId?: string): CourseState | null {
	const state = stores.courseStore.read();
	const course = state.courses.find((c) => c.id === courseId);
	if (!course) return null;
	if (folderId !== undefined && !course.folders.some((f) => f.id === folderId)) return null;
	return state;
}

function setFileStatus(courseId: string, next: CourseFileStatus): void {
	const list = runtime().statuses.get(courseId);
	if (!list) return;
	const idx = list.findIndex((s) => s.path === next.path);
	if (idx >= 0) list[idx] = next;
	else list.push(next);
}

function removeFileStatus(courseId: string, absPath: string): void {
	const list = runtime().statuses.get(courseId);
	if (!list) return;
	runtime().statuses.set(courseId, list.filter((s) => s.path !== absPath));
}

async function runExtractWithBusyRetry(
	courseId: string,
	folderId: string,
	input: { sourceId: string; filePath: string; text: string },
): Promise<"ok" | "cancelled"> {
	const extract: CourseExtractor =
		runtime().extractorOverride ??
		((args) => extraction.importNotes({ filePath: args.filePath, text: args.text, sourceId: args.sourceId }));
	const deadline = Date.now() + BUSY_MAX_WAIT_MS;
	for (;;) {
		if (!isCourseActive(courseId, folderId)) return "cancelled";
		try {
			await extract(input);
			return "ok";
		} catch (err) {
			if (err instanceof NotesImportError && err.outcome === "busy" && Date.now() < deadline) {
				await delay(BUSY_RETRY_DELAY_MS);
				continue;
			}
			throw err;
		}
	}
}

async function runCourseScan(courseId: string): Promise<void> {
	const rt = runtime();
	try {
		const initial = stores.courseStore.read();
		const course = initial.courses.find((c) => c.id === courseId);
		if (!course) {
			rt.statuses.delete(courseId);
			return;
		}

		const discovered = await discoverCourseFiles(course.folders);
		const afterWalk = stores.courseStore.read();
		const stillCourse = afterWalk.courses.find((c) => c.id === courseId);
		if (!stillCourse) {
			rt.statuses.delete(courseId);
			emit("courses-changed", {});
			return;
		}

		const activeFolderIds = new Set(stillCourse.folders.map((f) => f.id));
		const statuses: CourseFileStatus[] = [];
		const queue: Array<{ absPath: string; folder: CourseFolder }> = [];

		for (const file of discovered) {
			if (!activeFolderIds.has(file.folder.id)) continue;
			const currentFiles = stores.courseStore.read().folderFiles;
			const currentRec = Object.hasOwn(currentFiles, file.absPath) ? currentFiles[file.absPath] : undefined;
			if (currentRec && currentRec.courseId === courseId && currentRec.excluded) {
				statuses.push({ path: file.absPath, folderId: file.folder.id, state: "excluded" });
				continue;
			}
			if (file.size > MAX_IMPORT_BYTES) {
				statuses.push({ path: file.absPath, folderId: file.folder.id, state: "failed", error: oversizeMessage() });
				continue;
			}
			let bytes: Uint8Array;
			try {
				bytes = await fs.readFile(/* turbopackIgnore: true */ file.absPath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				statuses.push({
					path: file.absPath,
					folderId: file.folder.id,
					state: "failed",
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			if (bytes.byteLength > MAX_IMPORT_BYTES) {
				statuses.push({ path: file.absPath, folderId: file.folder.id, state: "failed", error: oversizeMessage() });
				continue;
			}

			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const latestFiles = stores.courseStore.read().folderFiles;
			const recorded = Object.hasOwn(latestFiles, file.absPath) ? latestFiles[file.absPath] : undefined;
			if (recorded && recorded.courseId === courseId && recorded.excluded) {
				statuses.push({ path: file.absPath, folderId: file.folder.id, state: "excluded" });
			} else if (recorded && recorded.sha256 === sha256 && recorded.courseId === courseId) {
				statuses.push({ path: file.absPath, folderId: file.folder.id, state: "extracted" });
			} else {
				statuses.push({ path: file.absPath, folderId: file.folder.id, state: "queued" });
				queue.push({ absPath: file.absPath, folder: file.folder });
			}
		}

		rt.statuses.set(courseId, statuses);
		emit("courses-changed", {});

		for (const item of queue) {
			const beforeState = isCourseActive(courseId);
			if (!beforeState) {
				rt.statuses.delete(courseId);
				emit("courses-changed", {});
				break;
			}
			if (!isCourseActive(courseId, item.folder.id)) {
				removeFileStatus(courseId, item.absPath);
				emit("courses-changed", {});
				continue;
			}
			// Deleted (excluded) since the queue was built: honour it.
			if (beforeState.folderFiles[item.absPath]?.excluded) {
				setFileStatus(courseId, { path: item.absPath, folderId: item.folder.id, state: "excluded" });
				emit("courses-changed", {});
				continue;
			}

			setFileStatus(courseId, { path: item.absPath, folderId: item.folder.id, state: "extracting" });
			emit("courses-changed", {});

			try {
				let bytes: Uint8Array;
				try {
					bytes = await fs.readFile(/* turbopackIgnore: true */ item.absPath);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") {
						removeFileStatus(courseId, item.absPath);
						emit("courses-changed", {});
						continue;
					}
					throw err;
				}
				if (bytes.byteLength > MAX_IMPORT_BYTES) {
					setFileStatus(courseId, { path: item.absPath, folderId: item.folder.id, state: "failed", error: oversizeMessage() });
					emit("courses-changed", {});
					continue;
				}

				const sha256 = createHash("sha256").update(bytes).digest("hex");
				const decoded = await decodeNotesBytes(bytes);
				if (decoded.kind === "refused") {
					setFileStatus(courseId, { path: item.absPath, folderId: item.folder.id, state: "failed", error: decoded.error });
					emit("courses-changed", {});
					continue;
				}

				const sourceId = courseFileSourceId(item.absPath);
				const displayPath = courseFileDisplayPath(item.folder.path, item.absPath);
				const result = await runExtractWithBusyRetry(courseId, item.folder.id, {
					sourceId,
					filePath: displayPath,
					text: decoded.text,
				});
				if (result === "cancelled") {
					if (!isCourseActive(courseId)) {
						rt.statuses.delete(courseId);
						emit("courses-changed", {});
						break;
					}
					removeFileStatus(courseId, item.absPath);
					emit("courses-changed", {});
					continue;
				}

				const latest = stores.courseStore.read();
				const latestCourse = latest.courses.find((c) => c.id === courseId);
				if (!latestCourse) {
					rt.statuses.delete(courseId);
					emit("courses-changed", {});
					break;
				}
				if (!latestCourse.folders.some((f) => f.id === item.folder.id)) {
					removeFileStatus(courseId, item.absPath);
					emit("courses-changed", {});
					continue;
				}
				// Never overwrite an exclusion recorded while this file extracted.
				if (latest.folderFiles[item.absPath]?.excluded) {
					setFileStatus(courseId, { path: item.absPath, folderId: item.folder.id, state: "excluded" });
					emit("courses-changed", {});
					continue;
				}

				setFileStatus(courseId, { path: item.absPath, folderId: item.folder.id, state: "extracted" });
				const nextState: CourseState = {
					...latest,
					membership: { ...latest.membership, [sourceId]: courseId },
					folderFiles: {
						...latest.folderFiles,
						[item.absPath]: {
							courseId,
							folderId: item.folder.id,
							sourceId,
							sha256,
							extractedAt: new Date().toISOString(),
						},
					},
				};
				stores.courseStore.write(nextState);

				const orgState = stores.sourceOrganizationStore.read();
				const nextOrg = placeImportedSource(orgState, sourceId, displayPath, () => ({
					id: `folder_${randomUUID()}`,
					createdAt: new Date().toISOString(),
				}));
				if (nextOrg !== orgState) {
					stores.sourceOrganizationStore.write(nextOrg);
				} else {
					emit("sources-changed", {});
				}
			} catch (err) {
				if (!isCourseActive(courseId)) {
					rt.statuses.delete(courseId);
					emit("courses-changed", {});
					break;
				}
				if (!isCourseActive(courseId, item.folder.id)) {
					removeFileStatus(courseId, item.absPath);
					emit("courses-changed", {});
					continue;
				}
				setFileStatus(courseId, {
					path: item.absPath,
					folderId: item.folder.id,
					state: "failed",
					error: err instanceof Error ? err.message : String(err),
				});
				emit("courses-changed", {});
			}
		}
	} finally {
		rt.activeScans.delete(courseId);
		emit("courses-changed", {});
		if (rt.pendingScans.delete(courseId)) startCourseScan(courseId);
	}
}

/** Start a background scan of the course's own folders (no-op if running).
 * Called after "add-folder" and on { action: "rescan" }. */
export function startCourseScan(courseId: string): void {
	const rt = runtime();
	if (rt.activeScans.has(courseId)) { rt.pendingScans.add(courseId); return; }
	const state = stores.courseStore.read();
	const course = state.courses.find((c) => c.id === courseId);
	if (!course) return;
	if (course.folders.length === 0) {
		if (rt.statuses.has(courseId)) {
			rt.statuses.delete(courseId);
			emit("courses-changed", {});
		}
		return;
	}
	const pass = runCourseScan(courseId);
	rt.activeScans.set(courseId, pass);
	emit("courses-changed", {});
}

/** Drop cached status for a deleted course, or for deleted sources. */
export function forgetCourseStatuses(courseId: string): void {
	runtime().statuses.delete(courseId);
	runtime().pendingScans.delete(courseId);
}

/** Per-file status for the course panel. */
export function courseFileStatuses(courseId: string): CourseFileStatus[] {
	const state = stores.courseStore.read();
	const course = state.courses.find((c) => c.id === courseId);
	if (!course) return [];
	const folderIds = new Set(course.folders.map((f) => f.id));
	const cached = runtime().statuses.get(courseId);
	if (cached) {
		// A source deleted elsewhere becomes excluded (or drops out of
		// folderFiles); never keep reporting it as extracted.
		const out: CourseFileStatus[] = [];
		for (const s of cached) {
			if (!folderIds.has(s.folderId)) continue;
			const rec = Object.hasOwn(state.folderFiles, s.path) ? state.folderFiles[s.path] : undefined;
			if (rec?.courseId === courseId && rec.excluded) {
				out.push({ path: s.path, folderId: s.folderId, state: "excluded" });
			} else if (s.state === "extracted" && rec?.courseId !== courseId) {
				continue;
			} else if (s.state === "excluded" && !rec?.excluded) {
				continue;
			} else {
				out.push({ ...s });
			}
		}
		return out;
	}
	const out: CourseFileStatus[] = [];
	for (const [absPath, rec] of Object.entries(state.folderFiles)) {
		if (rec.courseId !== courseId || !folderIds.has(rec.folderId)) continue;
		if (!fsSync.existsSync(/* turbopackIgnore: true */ absPath)) continue;
		out.push({ path: absPath, folderId: rec.folderId, state: rec.excluded ? "excluded" : "extracted" });
	}
	return out;
}

export function courseScanning(courseId: string): boolean {
	return runtime().activeScans.has(courseId);
}
