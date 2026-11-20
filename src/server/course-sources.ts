/** Course source folders: scan, extract new/changed files, report status.
 * STUB owned by work package WP-C (feat/courses-sources); the signatures are
 * the contract WP-A's /api/courses route calls. */
import type { CourseFileStatus } from "../core/contracts/courses.ts";

/** Start a background scan of the course's own folders (no-op if running).
 * Called after "add-folder" and on { action: "rescan" }. */
export function startCourseScan(courseId: string): void { void courseId; }

/** Per-file status for the course panel. */
export function courseFileStatuses(courseId: string): CourseFileStatus[] { void courseId; return []; }

export function courseScanning(courseId: string): boolean { void courseId; return false; }
