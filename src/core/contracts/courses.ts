/** COURSES (owner, 2026-11-20): a course is a named set of sources (chat
 * sessions and imported files). Its graph is a read-time PROJECTION of the
 * one global graph — the ledgers are untouched and extraction still links
 * against the whole graph, so a fact learned in two courses is one shared
 * node that appears in both. Stored in one sidecar, data/graph/courses.json,
 * like source-organization.json. */

/** One attached resource folder (absolute path on the server's filesystem). */
export interface CourseFolder {
	id: string;
	path: string;
	addedAt: string;
}

export interface Course {
	/** "crs_" + random id. */
	id: string;
	name: string;
	createdAt: string;
	/** LIVE whole-course includes, resolved transitively; cycles are rejected. */
	includes: string[];
	folders: CourseFolder[];
}

/** Extraction bookkeeping for one file found in a course folder. */
export interface CourseFolderFile {
	courseId: string;
	folderId: string;
	/** The notes source id the file was extracted as (src_ + hash). */
	sourceId: string;
	/** sha256 hex of the file bytes at the last successful extraction. */
	sha256: string;
	extractedAt: string;
}

export interface CourseState {
	version: 1;
	courses: Course[];
	/** Source id (chatId or src_ id) → its ONE course. Absent = "No course". */
	membership: Record<string, string>;
	/** Absolute file path → bookkeeping. */
	folderFiles: Record<string, CourseFolderFile>;
}

/** What the app is scoped to: everything, the unassigned sources, or one course. */
export type CourseFilter =
	| { kind: "all" }
	| { kind: "none" }
	| { kind: "course"; courseId: string };

/** The resolved scope of a course: its own sources plus every (transitively)
 * included course's own sources. */
export interface CourseScope {
	courseId: string;
	/** The course and every transitively included course, the course first. */
	courseIds: string[];
	/** Sources owned by the course itself. */
	ownSources: ReadonlySet<string>;
	/** ownSources ∪ every included course's own sources. */
	sources: ReadonlySet<string>;
	/** Source id → owning course id, for every source in `sources`. */
	sourceCourse: ReadonlyMap<string, string>;
	/** Folders of the course first, then of included courses (dedup by path). */
	folders: Array<CourseFolder & { courseId: string }>;
}

export type CourseAction =
	| { action: "create"; name: string; includes?: string[] }
	| { action: "rename"; id: string; name: string }
	| { action: "set-includes"; id: string; includes: string[] }
	| { action: "assign"; sourceId: string; courseId: string | null }
	| { action: "add-folder"; id: string; path: string }
	| { action: "remove-folder"; id: string; folderId: string }
	/** mode "ungroup": sources go to No course; "delete-sources": the caller
	 * also deletes the course's own sources through source deletion. */
	| { action: "delete"; id: string; mode: "ungroup" | "delete-sources" };

// ─── HTTP transport (GET/POST /api/courses) ──────────────────────────────────

export type CourseFileState = "queued" | "extracting" | "extracted" | "failed";

/** One supported file found in a course folder, for the course panel. */
export interface CourseFileStatus {
	path: string;
	folderId: string;
	state: CourseFileState;
	error?: string;
}

export interface CourseView extends Course {
	/** Own sources (chats + files) assigned to the course. */
	ownSourceIds: string[];
	/** Transitive includes, resolved (excluding the course itself). */
	includedCourseIds: string[];
	/** Per-file extraction status across the course's own folders. */
	files: CourseFileStatus[];
	/** True while a scan/extraction pass runs for this course. */
	scanning: boolean;
}

/** GET /api/courses and every POST /api/courses response. */
export interface CoursesView {
	courses: CourseView[];
	membership: Record<string, string>;
}

/** POST /api/courses bodies: a CourseAction, or { action: "rescan", id } which
 * starts a background scan of the course's folders (new/changed files). */
export type CourseRequest = CourseAction | { action: "rescan"; id: string };
