/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import type { CourseState } from "../core/contracts/courses.ts";
import { courseOf, resolveCourseScope } from "../core/courses.ts";
import { courseStore } from "../store/courses.ts";
import { readFileAccessSettings } from "../store/settings.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

export function fileAccessPolicy(chatId?: string): FileAccessPolicy {
	if (chatId) {
		let state: CourseState;
		try { state = courseStore.read(); }
		catch (error) { return { restricted: true, folders: [], error: error instanceof Error ? error.message : "Could not read courses." }; }
		const courseId = courseOf(state, chatId);
		if (courseId !== null) {
			const scope = resolveCourseScope(state, courseId);
			if (scope) {
				const folders: string[] = [];
				for (const folder of scope.folders) {
					try { folders.push(expandFolder(folder.path)); }
					catch { return { restricted: true, folders: [], error: `Invalid course folder path: ${folder.path}` }; }
				}
				const sessionPaths = Object.hasOwn(state.sessionFiles, chatId) ? state.sessionFiles[chatId]! : [];
				for (const filePath of sessionPaths) {
					try {
						const expanded = expandFolder(filePath);
						if (!folders.includes(expanded)) folders.push(expanded);
					} catch {
						return { restricted: true, folders: [], error: `Invalid session file path: ${filePath}` };
					}
				}
				return { restricted: true, folders };
			}
		}
	}
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	return { restricted: result.settings.restricted, folders: result.settings.folders.map((folder) => expandFolder(folder)) };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
