import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CourseAction, CourseFilter, CourseState, CoursesView } from "../core/contracts/courses.ts";
import type { SourceDirectory } from "../core/source-organization.ts";
import { isWithin } from "../agent/tools/file-access.ts";
import { applyCourseAction, courseClosure, ownSourcesOf, parseCourseAction, sourceInFilter } from "../core/courses.ts";
import { emit } from "../core/events.ts";
import { courseFileStatuses, courseScanning, forgetCourseStatuses, startCourseScan } from "./course-sources.ts";
import { deleteSources, SourceDeletionError } from "./source-deletion.ts";
import { sourceDirectory } from "./source-organization.ts";
import { stores } from "./stores.ts";

export class CourseInputError extends Error {}
export class UnknownCourseError extends Error {}

function resolveCourseFolderPath(rawPath: string, home: string = os.homedir()): string {
	let expanded: string;
	if (rawPath === "~") expanded = home;
	else if (rawPath.startsWith("~/")) expanded = path.join(home, rawPath.slice(2));
	else expanded = rawPath;
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
