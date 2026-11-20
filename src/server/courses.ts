import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COURSE_FILES_DIR } from "../../config.ts";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, UNSUPPORTED_TYPE_MESSAGE } from "../../lib/notes-import-limits.ts";
import type {
	CourseAction,
	CourseFilesResponse,
	CourseFilter,
	CourseFolder,
	CourseFolderFile,
	CourseState,
	CoursesView,
} from "../core/contracts/courses.ts";
import type { SourceDirectory } from "../core/source-organization.ts";
import { isWithin, realSourcePath } from "../agent/tools/file-access.ts";
import { isProtectedSourcePath, isSensitivePath } from "../agent/tools/fs-shared.ts";
import { applyCourseAction, courseClosure, courseOf, ownSourcesOf, parseCourseAction, sourceInFilter } from "../core/courses.ts";
import { emit } from "../core/events.ts";
import { courseFileStatuses, courseScanning, forgetCourseStatuses, startCourseScan } from "./course-sources.ts";
import { expandFolder } from "./file-access.ts";
import { deleteSources, SourceDeletionError } from "./source-deletion.ts";
import { readBoundedJsonBody, sourceDirectory } from "./source-organization.ts";
import { stores } from "./stores.ts";

export class CourseInputError extends Error {}
export class CoursePayloadTooLargeError extends Error {}
export class UnknownCourseError extends Error {}

function canonicalFolderPath(rawPath: string): string {
	let lexical: string;
	try {
		lexical = expandFolder(rawPath);
	} catch {
		lexical = path.resolve(rawPath);
	}
	try {
		return realSourcePath(lexical);
	} catch {
		return lexical;
	}
}

function assertNoFolderOverlap(state: CourseState, targetId: string, candidatePath: string): void {
	const candidateCanonical = canonicalFolderPath(candidatePath);
	// File identity and membership are global per path, so one canonical
	// folder tree may belong to only one course.
	for (const other of state.courses) {
		for (const folder of other.folders) {
			const existingCanonical = canonicalFolderPath(folder.path);
			if (isWithin(candidateCanonical, existingCanonical) || isWithin(existingCanonical, candidateCanonical)) {
				throw new CourseInputError(other.id === targetId
					? "This folder overlaps a folder already attached to this course."
					: `This folder overlaps a folder already attached to the course "${other.name}".`);
			}
		}
	}
}

function resolveCourseFolderPath(rawPath: string, home: string = os.homedir()): string {
	let normalized: string;
	try {
		normalized = expandFolder(rawPath, home);
	} catch {
		throw new CourseInputError("Folder path must be an absolute path.");
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(normalized);
	} catch {
		throw new CourseInputError("Folder does not exist on this machine.");
	}
	if (!stat.isDirectory()) throw new CourseInputError("Folder path must point to a directory.");
	return normalized;
}

function resolveSessionFilePath(rawPath: string, home: string = os.homedir()): string {
	if (rawPath.includes("\0")) {
		throw new CourseInputError("File path must be an absolute path.");
	}
	let normalized: string;
	try {
		normalized = expandFolder(rawPath, home);
	} catch {
		throw new CourseInputError("File path must be an absolute path.");
	}
	if (normalized.includes("\0")) {
		throw new CourseInputError("File path must be an absolute path.");
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(/* turbopackIgnore: true */ normalized);
	} catch {
		throw new CourseInputError("File does not exist on this machine.");
	}
	if (!stat.isFile()) throw new CourseInputError("File path must point to a regular file.");
	let real: string;
	try {
		real = fs.realpathSync.native(/* turbopackIgnore: true */ normalized);
	} catch {
		throw new CourseInputError("File does not exist on this machine.");
	}
	if (isSensitivePath(normalized) || isSensitivePath(real) || isProtectedSourcePath(normalized) || isProtectedSourcePath(real)) {
		throw new CourseInputError("File path points to a protected location.");
	}
	// Store the CANONICAL path: the policy treats it as one file and refuses
	// it if it later resolves anywhere else.
	return real;
}

function buildCoursesView(state: CourseState): CoursesView {
	return {
		courses: state.courses.map((course) => ({
			...course,
			ownSourceIds: ownSourcesOf(state, course.id),
			includedCourseIds: courseClosure(state, course.id).slice(1),
			files: courseFileStatuses(course.id),
			scanning: courseScanning(course.id),
		})),
		membership: state.membership,
	};
}

export function coursesView(): CoursesView {
	return buildCoursesView(stores.courseStore.read());
}

export function parseCourseFilterParam(courseParam?: string | null): { state: CourseState; filter: CourseFilter } | null {
	if (courseParam === undefined || courseParam === null) return null;
	const state = stores.courseStore.read();
	if (courseParam === "none") return { state, filter: { kind: "none" } };
	if (!state.courses.some((c) => c.id === courseParam)) {
		throw new UnknownCourseError("Course not found.");
	}
	return { state, filter: { kind: "course", courseId: courseParam } };
}

export function scopedSourceDirectory(courseParam?: string | null): SourceDirectory {
	const directory = sourceDirectory.read();
	const courseFilter = parseCourseFilterParam(courseParam);
	if (!courseFilter) return directory;
	return {
		organization: directory.organization,
		sources: directory.sources.filter((s) => sourceInFilter(courseFilter.state, courseFilter.filter, s.id)),
	};
}

export function mutateCourses(raw: unknown): CoursesView {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new CourseInputError("Invalid course action.");
	}
	const record = raw as Record<string, unknown>;
	if (record.action === "rescan") {
		const id = typeof record.id === "string" ? record.id.trim() : "";
		if (!id) throw new CourseInputError("Course ID must be a non-empty string.");
		const state = stores.courseStore.read();
		if (!state.courses.some((c) => c.id === id)) throw new CourseInputError("Course no longer exists.");
		startCourseScan(id);
		return buildCoursesView(state);
	}

	let action: CourseAction;
	try {
		action = parseCourseAction(raw);
	} catch (error) {
		throw new CourseInputError((error as Error).message);
	}

	let state = stores.courseStore.read();

	if (action.action === "add-folder") {
		const targetId = action.id;
		if (!state.courses.some((c) => c.id === targetId)) throw new CourseInputError("Course no longer exists.");
		const folderPath = resolveCourseFolderPath(action.path);
		assertNoFolderOverlap(state, targetId, folderPath);
		action = { ...action, path: folderPath };
	}

	if (action.action === "attach-session-files") {
		if (!stores.chatStore.getChat(action.chatId)) {
			throw new CourseInputError("Session no longer exists.");
		}
		const chatCourseId = courseOf(state, action.chatId);
		if (!chatCourseId || !state.courses.some((c) => c.id === chatCourseId)) {
			throw new CourseInputError("Session does not belong to a course.");
		}
		action = { ...action, paths: [...new Set(action.paths.map((p) => resolveSessionFilePath(p)))] };
	}

	if (action.action === "include-file" && !Object.hasOwn(state.folderFiles, action.path)) {
		try {
			action = { ...action, path: expandFolder(action.path) };
		} catch {
			// Relative or invalid paths stay unchanged so applyCourseAction reports not excluded.
		}
	}

	let deletedManagedFolders: readonly CourseFolder[] = [];
	let preDeleteState: CourseState | null = null;
	if (action.action === "delete") {
		const targetId = action.id;
		const targetCourse = state.courses.find((c) => c.id === targetId);
		if (!targetCourse) throw new CourseInputError("Course no longer exists.");
		if (action.mode === "delete-sources" && courseScanning(targetId)) {
			throw new SourceDeletionError("This course is still extracting its folders. Wait for it to finish, then delete.", 409, "extraction_running");
		}
		if (action.mode === "delete-sources") {
			deletedManagedFolders = targetCourse.folders.filter((f) => f.managed);
			preDeleteState = state;
			const ownSources = ownSourcesOf(state, targetId);
			if (ownSources.length > 0) {
				deleteSources({ sourceIds: ownSources, folderIds: [], deleteSessions: true });
				emit("sources-changed", {});
				emit("chats-changed", {});
				state = stores.courseStore.read();
			}
		}
	}

	const fresh = {
		id: action.action === "create" ? `crs_${randomUUID()}` : action.action === "add-folder" ? `cfld_${randomUUID()}` : "",
		at: new Date().toISOString(),
	};

	let next: CourseState;
	try {
		next = applyCourseAction(state, action, fresh);
	} catch (error) {
		throw new CourseInputError((error as Error).message);
	}

	stores.courseStore.write(next);
	if (action.action === "delete") {
		if (action.mode === "delete-sources" && preDeleteState) {
			removeManagedCourseFolders(deletedManagedFolders, action.id, preDeleteState);
		}
		forgetCourseStatuses(action.id);
	}
	if (action.action === "add-folder" || action.action === "include-file") startCourseScan(action.id);
	return buildCoursesView(next);
}

function removeManagedCourseFolders(
	folders: readonly CourseFolder[],
	deletedCourseId: string,
	preDeleteState: CourseState,
): void {
	if (folders.length === 0) return;
	const managedRoot = path.resolve(COURSE_FILES_DIR);
	let realRoot: string;
	try {
		realRoot = fs.realpathSync.native(/* turbopackIgnore: true */ managedRoot);
	} catch {
		return;
	}
	const folderFileByPath = new Map<string, CourseFolderFile>();
	for (const [recordedPath, rec] of Object.entries(preDeleteState.folderFiles)) {
		folderFileByPath.set(path.resolve(recordedPath), rec);
		try {
			folderFileByPath.set(fs.realpathSync.native(/* turbopackIgnore: true */ recordedPath), rec);
		} catch {
			// Missing file keeps its lexical key only.
		}
	}
	const shouldKeepFile = (realFilePath: string, lexicalFilePath: string): boolean => {
		const rec = folderFileByPath.get(lexicalFilePath) ?? folderFileByPath.get(realFilePath);
		if (!rec) return false;
		const owner = courseOf(preDeleteState, rec.sourceId);
		return owner !== null && owner !== deletedCourseId;
	};
	const pruneDirectory = (realDir: string, lexicalDir: string): boolean => {
		let keptAnything = false;
		const entries = fs.readdirSync(/* turbopackIgnore: true */ realDir, { withFileTypes: true });
		for (const entry of entries) {
			const entryReal = path.join(/* turbopackIgnore: true */ realDir, entry.name);
			const entryLexical = path.join(/* turbopackIgnore: true */ lexicalDir, entry.name);
			if (entry.isDirectory()) {
				if (pruneDirectory(entryReal, entryLexical)) keptAnything = true;
			} else if (shouldKeepFile(entryReal, entryLexical)) {
				keptAnything = true;
			} else {
				fs.rmSync(/* turbopackIgnore: true */ entryReal, { force: true });
			}
		}
		if (!keptAnything) {
			fs.rmdirSync(/* turbopackIgnore: true */ realDir);
			return false;
		}
		return true;
	};
	for (const folder of folders) {
		if (!folder.managed) continue;
		const lexical = path.resolve(folder.path);
		if (lexical === managedRoot || !isWithin(lexical, managedRoot)) continue;
		let lstat: fs.Stats;
		try {
			lstat = fs.lstatSync(/* turbopackIgnore: true */ lexical);
		} catch {
			continue;
		}
		if (lstat.isSymbolicLink()) continue;
		let realTarget: string;
		try {
			realTarget = fs.realpathSync.native(/* turbopackIgnore: true */ lexical);
		} catch {
			continue;
		}
		if (realTarget === realRoot || !isWithin(realTarget, realRoot)) continue;
		pruneDirectory(realTarget, lexical);
	}
}

const MAX_UPLOAD_FILENAME_BYTES = 240;

function sanitizeUploadFilename(rawName: string): string {
	if (typeof rawName !== "string" || !rawName.trim()) {
		throw new CourseInputError("File name must be a non-empty string.");
	}
	if (/[\x00-\x1f\x7f]/.test(rawName)) {
		throw new CourseInputError("File name contains invalid control characters.");
	}
	if (rawName.includes("/") || rawName.includes("\\") || (process.platform === "win32" && rawName.includes(":"))) {
		throw new CourseInputError("File name must not contain path separators.");
	}
	const base = path.basename(rawName);
	if (!base || base === "." || base === ".." || base !== rawName) {
		throw new CourseInputError("Invalid file name.");
	}
	// Block dotenv names before stripping leading dots so `.env.md` cannot bypass ENV_FILE.
	if (isSensitivePath(path.join("/", base))) {
		throw new CourseInputError("File name is not allowed.");
	}
	const stripped = base.replace(/^\.+/, "");
	if (!stripped || !stripped.trim()) {
		throw new CourseInputError("Invalid file name.");
	}
	if (Buffer.byteLength(stripped, "utf8") > MAX_UPLOAD_FILENAME_BYTES) {
		throw new CourseInputError("File name is too long.");
	}
	return stripped;
}

function oversizeUploadMessage(): string {
	return `File is too large (max ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB).`;
}

async function writeUniqueCourseFile(dir: string, realDir: string, filename: string, bytes: Uint8Array): Promise<string> {
	const ext = path.extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
	const flags = O_WRONLY | O_CREAT | O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
	for (let n = 1; ; n++) {
		const candidateName = n === 1 ? filename : `${stem} (${n})${ext}`;
		const targetPath = path.join(/* turbopackIgnore: true */ dir, candidateName);
		let handle: fsPromises.FileHandle;
		try {
			handle = await fsPromises.open(/* turbopackIgnore: true */ targetPath, flags, 0o644);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
		try {
			// Verify where the (still empty) file actually landed BEFORE writing:
			// a directory swapped for a link after validation must not receive data.
			const real = await fsPromises.realpath(/* turbopackIgnore: true */ targetPath);
			const [opened, onDisk] = await Promise.all([handle.stat(), fsPromises.stat(/* turbopackIgnore: true */ real)]);
			if (path.dirname(real) !== realDir || opened.ino !== onDisk.ino || opened.dev !== onDisk.dev) {
				await handle.close();
				await fsPromises.unlink(/* turbopackIgnore: true */ real).catch(() => undefined);
				throw new CourseInputError("The course's managed file folder changed while uploading. Try again.");
			}
			await handle.writeFile(bytes);
		} finally {
			await handle.close().catch(() => undefined);
		}
		return targetPath;
	}
}

export interface AddCourseFilesInput {
	courseId: string;
	files: readonly File[];
	chatId?: string | null;
}

async function assertManagedCourseDir(managedRoot: string, managedDir: string): Promise<string> {
	const refuse = () => { throw new CourseInputError("The course's managed file folder is not a plain folder inside LearnHarness data."); };
	for (const dir of [managedRoot, managedDir]) {
		const st = await fsPromises.lstat(/* turbopackIgnore: true */ dir).catch(() => null);
		if (!st || st.isSymbolicLink() || !st.isDirectory()) refuse();
	}
	const realRoot = await fsPromises.realpath(/* turbopackIgnore: true */ managedRoot);
	const realDir = await fsPromises.realpath(/* turbopackIgnore: true */ managedDir);
	if (path.dirname(realDir) !== realRoot || path.basename(realDir) !== path.basename(managedDir)) refuse();
	return realDir;
}

/** Copy uploaded files into `<data>/course-files/<courseId>/`, attach the
 * managed folder on first use, optionally grant session access, and scan. */
export async function addCourseFiles(input: AddCourseFilesInput): Promise<CourseFilesResponse> {
	const courseId = input.courseId.trim();
	if (!courseId || courseId === "." || courseId === ".." || courseId.includes("/") || courseId.includes("\\") || courseId.includes("\0")) {
		throw new CourseInputError("Course ID must be a non-empty string.");
	}
	const initialState = stores.courseStore.read();
	const initialCourse = initialState.courses.find((c) => c.id === courseId);
	if (!initialCourse) {
		throw new CourseInputError("Course not found.");
	}
	const managedRoot = path.resolve(COURSE_FILES_DIR);
	const managedDir = path.resolve(path.join(/* turbopackIgnore: true */ managedRoot, courseId));
	if (managedDir === managedRoot || !isWithin(managedDir, managedRoot)) {
		throw new CourseInputError("Invalid course ID.");
	}
	const managedCanonical = canonicalFolderPath(managedDir);
	if (!initialCourse.folders.some((f) => canonicalFolderPath(f.path) === managedCanonical)) {
		assertNoFolderOverlap(initialState, courseId, managedDir);
	}

	const rawChatId = input.chatId?.trim() ?? "";
	const chatId = rawChatId || undefined;
	if (chatId === "__proto__" || chatId === "constructor" || chatId === "prototype") {
		throw new CourseInputError("Invalid chat ID.");
	}
	if (chatId) {
		if (!stores.chatStore.getChat(chatId)) {
			throw new CourseInputError("Session no longer exists.");
		}
		if (courseOf(initialState, chatId) !== courseId) {
			throw new CourseInputError("Session does not belong to this course.");
		}
	}
	if (input.files.length === 0) {
		throw new CourseInputError("Select at least one file.");
	}

	const entries: Array<{ filename: string; bytes: Uint8Array }> = [];
	for (const file of input.files) {
		const filename = sanitizeUploadFilename(file.name);
		if (!IMPORT_EXTENSIONS.test(filename)) {
			throw new CourseInputError(UNSUPPORTED_TYPE_MESSAGE);
		}
		if (isSensitivePath(path.join(/* turbopackIgnore: true */ managedDir, filename))) {
			throw new CourseInputError("File name is not allowed.");
		}
		if (file.size > MAX_IMPORT_BYTES) {
			throw new CoursePayloadTooLargeError(oversizeUploadMessage());
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.byteLength > MAX_IMPORT_BYTES) {
			throw new CoursePayloadTooLargeError(oversizeUploadMessage());
		}
		entries.push({ filename, bytes });
	}

	if (!stores.courseStore.read().courses.some((c) => c.id === courseId)) {
		throw new CourseInputError("Course no longer exists.");
	}
	await fsPromises.mkdir(/* turbopackIgnore: true */ managedDir, { recursive: true });

	const copied: string[] = [];
	try {
		for (const { filename, bytes } of entries) {
			// Re-checked before every write: the managed directory must be a
			// real directory directly inside the managed root, never a link.
			const realDir = await assertManagedCourseDir(managedRoot, managedDir);
			copied.push(await writeUniqueCourseFile(managedDir, realDir, filename, bytes));
		}

		const state = stores.courseStore.read();
		const course = state.courses.find((c) => c.id === courseId);
		if (!course) throw new CourseInputError("Course no longer exists.");

		let next = state;
		if (!course.folders.some((f) => f.path === managedDir || canonicalFolderPath(f.path) === managedCanonical)) {
			assertNoFolderOverlap(state, courseId, managedDir);
			next = applyCourseAction(next, { action: "add-folder", id: courseId, path: managedDir }, {
				id: `cfld_${randomUUID()}`,
				at: new Date().toISOString(),
			});
			const addedCourse = next.courses.find((c) => c.id === courseId)!;
			const addedFolder = addedCourse.folders.find((f) => f.path === managedDir)!;
			addedFolder.managed = true;
		}

		if (chatId) {
			if (!stores.chatStore.getChat(chatId)) {
				throw new CourseInputError("Session no longer exists.");
			}
			if (courseOf(next, chatId) !== courseId) {
				throw new CourseInputError("Session does not belong to this course.");
			}
			// Grants are canonical (the policy refuses a grant that resolves elsewhere).
			const grants = copied.map((p) => fs.realpathSync.native(/* turbopackIgnore: true */ p));
			next = applyCourseAction(next, { action: "attach-session-files", chatId, paths: grants }, {
				id: "",
				at: new Date().toISOString(),
			});
		}

		if (next !== state) {
			stores.courseStore.write(next);
		}
		startCourseScan(courseId);
		return { ...buildCoursesView(next), copied };
	} catch (error) {
		for (const p of copied) {
			await fsPromises.rm(/* turbopackIgnore: true */ p, { force: true }).catch(() => undefined);
		}
		throw error;
	}
}

/** Drop membership and sessionFiles for deleted sources, and mark deleted
 * folder-file entries `excluded: true` (keeping sha256) so scans skip them
 * until re-included via `include-file`. */
export function removeSourcesFromCourses(sourceIds: ReadonlySet<string>): void {
	if (sourceIds.size === 0) return;
	const state = stores.courseStore.read();
	const next = structuredClone(state);
	let changed = false;
	for (const id of sourceIds) {
		if (Object.hasOwn(next.membership, id)) {
			delete next.membership[id];
			changed = true;
		}
		if (Object.hasOwn(next.sessionFiles, id)) {
			delete next.sessionFiles[id];
			changed = true;
		}
	}
	for (const rec of Object.values(next.folderFiles)) {
		if (sourceIds.has(rec.sourceId) && !rec.excluded) {
			rec.excluded = true;
			changed = true;
		}
	}
	if (changed) stores.courseStore.write(next);
}

/** Bound actual JSON bytes as well as declared size; share readBoundedJsonBody. */
export function readCourseRequest(request: Request): Promise<unknown> {
	return readBoundedJsonBody(request, {
		makeError: (message) => new CourseInputError(message),
		tooLarge: "Course request is too large.",
		missing: "Missing course action.",
		invalid: "Could not read course action.",
	});
}
