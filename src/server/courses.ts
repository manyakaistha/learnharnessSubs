import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COURSE_FILES_DIR } from "../../config.ts";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, UNSUPPORTED_TYPE_MESSAGE } from "../../lib/notes-import-limits.ts";
import type { CourseAction, CourseFilesResponse, CourseFilter, CourseState, CoursesView } from "../core/contracts/courses.ts";
import type { SourceDirectory } from "../core/source-organization.ts";
import { isWithin } from "../agent/tools/file-access.ts";
import { isProtectedSourcePath, isSensitivePath } from "../agent/tools/fs-shared.ts";
import { applyCourseAction, courseClosure, courseOf, ownSourcesOf, parseCourseAction, sourceInFilter } from "../core/courses.ts";
import { emit } from "../core/events.ts";
import { courseFileStatuses, courseScanning, forgetCourseStatuses, startCourseScan } from "./course-sources.ts";
import { deleteSources, SourceDeletionError } from "./source-deletion.ts";
import { sourceDirectory } from "./source-organization.ts";
import { stores } from "./stores.ts";

export class CourseInputError extends Error {}
export class CoursePayloadTooLargeError extends Error {}
export class UnknownCourseError extends Error {}

function expandHomePath(rawPath: string, home: string = os.homedir()): string {
	if (rawPath === "~") return home;
	if (rawPath.startsWith("~/") || rawPath.startsWith(`~${path.sep}`)) return path.join(home, rawPath.slice(2));
	return rawPath;
}

function resolveCourseFolderPath(rawPath: string, home: string = os.homedir()): string {
	const expanded = expandHomePath(rawPath, home);
	if (!path.isAbsolute(expanded)) throw new CourseInputError("Folder path must be an absolute path.");
	const normalized = path.resolve(expanded);
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
	const expanded = expandHomePath(rawPath, home);
	if (expanded.includes("\0") || !path.isAbsolute(expanded)) {
		throw new CourseInputError("File path must be an absolute path.");
	}
	const normalized = path.resolve(expanded);
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
	if (isSensitivePath(normalized) || isSensitivePath(real) || isProtectedSourcePath(normalized)) {
		throw new CourseInputError("File path points to a protected location.");
	}
	return normalized;
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
		// File identity and membership are global per path, so one folder
		// (or a nested one) may belong to only one course.
		for (const other of state.courses) {
			for (const folder of other.folders) {
				if (isWithin(folderPath, folder.path) || isWithin(folder.path, folderPath)) {
					throw new CourseInputError(other.id === targetId
						? "This folder overlaps a folder already attached to this course."
						: `This folder overlaps a folder already attached to the course "${other.name}".`);
				}
			}
		}
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

	if (action.action === "delete") {
		const targetId = action.id;
		if (!state.courses.some((c) => c.id === targetId)) throw new CourseInputError("Course no longer exists.");
		if (action.mode === "delete-sources" && courseScanning(targetId)) {
			throw new SourceDeletionError("This course is still extracting its folders. Wait for it to finish, then delete.", 409, "extraction_running");
		}
		if (action.mode === "delete-sources") {
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
	if (action.action === "delete") forgetCourseStatuses(action.id);
	if (action.action === "add-folder") startCourseScan(action.id);
	return buildCoursesView(next);
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
	if (!base || base === "." || base === ".." || base !== rawName || base.startsWith(".")) {
		throw new CourseInputError("Invalid file name.");
	}
	if (Buffer.byteLength(base, "utf8") > MAX_UPLOAD_FILENAME_BYTES) {
		throw new CourseInputError("File name is too long.");
	}
	return base;
}

function oversizeUploadMessage(): string {
	return `File is too large (max ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB).`;
}

async function writeUniqueCourseFile(dir: string, filename: string, bytes: Uint8Array): Promise<string> {
	const ext = path.extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	for (let n = 1; ; n++) {
		const candidateName = n === 1 ? filename : `${stem} (${n})${ext}`;
		const targetPath = path.join(/* turbopackIgnore: true */ dir, candidateName);
		try {
			await fsPromises.writeFile(/* turbopackIgnore: true */ targetPath, bytes, { flag: "wx" });
			return targetPath;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
	}
}

export interface AddCourseFilesInput {
	courseId: string;
	files: readonly File[];
	chatId?: string | null;
}

/** Copy uploaded files into `<data>/course-files/<courseId>/`, attach the
 * managed folder on first use, optionally grant session access, and scan. */
export async function addCourseFiles(input: AddCourseFilesInput): Promise<CourseFilesResponse> {
	const courseId = input.courseId.trim();
	if (!courseId || courseId === "." || courseId === ".." || courseId.includes("/") || courseId.includes("\\") || courseId.includes("\0")) {
		throw new CourseInputError("Course ID must be a non-empty string.");
	}
	const initialState = stores.courseStore.read();
	if (!initialState.courses.some((c) => c.id === courseId)) {
		throw new CourseInputError("Course not found.");
	}
	const managedRoot = path.resolve(COURSE_FILES_DIR);
	const managedDir = path.resolve(path.join(/* turbopackIgnore: true */ managedRoot, courseId));
	if (managedDir === managedRoot || !isWithin(managedDir, managedRoot)) {
		throw new CourseInputError("Invalid course ID.");
	}

	const rawChatId = input.chatId?.trim() ?? "";
	const chatId = rawChatId || undefined;
	if (chatId === "__proto__" || chatId === "constructor" || chatId === "prototype") {
		throw new CourseInputError("Invalid chat ID.");
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
			copied.push(await writeUniqueCourseFile(managedDir, filename, bytes));
		}

		const state = stores.courseStore.read();
		const course = state.courses.find((c) => c.id === courseId);
		if (!course) throw new CourseInputError("Course no longer exists.");

		let next = state;
		if (!course.folders.some((f) => f.path === managedDir)) {
			next = applyCourseAction(next, { action: "add-folder", id: courseId, path: managedDir }, {
				id: `cfld_${randomUUID()}`,
				at: new Date().toISOString(),
			});
			const addedCourse = next.courses.find((c) => c.id === courseId)!;
			const addedFolder = addedCourse.folders.find((f) => f.path === managedDir)!;
			addedFolder.managed = true;
		}

		if (chatId && stores.chatStore.getChat(chatId) && courseOf(next, chatId) === courseId) {
			next = applyCourseAction(next, { action: "attach-session-files", chatId, paths: copied }, {
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

/** Drop membership and folderFiles entries pointing at deleted sources so
 * courses.json never references vanished chats or notes files. */
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
	}
	for (const [filePath, rec] of Object.entries(next.folderFiles)) {
		if (sourceIds.has(rec.sourceId)) {
			delete next.folderFiles[filePath];
			changed = true;
		}
	}
	if (changed) stores.courseStore.write(next);
}

/** Bound actual JSON bytes as well as declared size; mirror readOrganizationAction. */
export async function readCourseRequest(request: Request): Promise<unknown> {
	const limit = 64 * 1024;
	if (Number(request.headers.get("content-length")) > limit) {
		void request.body?.cancel().catch(() => undefined);
		throw new CourseInputError("Course request is too large.");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new CourseInputError("Missing course action.");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new CourseInputError("Course request is too large.");
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		if (error instanceof CourseInputError) throw error;
		throw new CourseInputError("Could not read course action.");
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
