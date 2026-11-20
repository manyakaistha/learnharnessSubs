import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import type { Course, CourseAction, CourseFilter, CourseFolder, CourseScope, CourseState } from "./contracts/courses.ts";

/** Pure course logic (contracts/courses.ts). No fs, no ids minted here:
 * callers pass fresh ids and timestamps, like source-organization.ts. */

export const emptyCourseState = (): CourseState => ({ version: 1, courses: [], membership: {}, folderFiles: {}, sessionFiles: {} });

export const courseOf = (state: CourseState, sourceId: string): string | null =>
	Object.hasOwn(state.membership, sourceId) ? state.membership[sourceId]! : null;

const findCourse = (state: CourseState, id: string): Course | undefined => state.courses.find((c) => c.id === id);

/** Every course reachable from `id` through includes, `id` first (BFS order).
 * Tolerates cycles and dangling ids in stored data. */
export function courseClosure(state: CourseState, id: string): string[] {
	const out: string[] = [];
	const queue = [id];
	while (queue.length) {
		const next = queue.shift()!;
		if (out.includes(next)) continue;
		const course = findCourse(state, next);
		if (!course) continue;
		out.push(next);
		queue.push(...course.includes);
	}
	return out;
}

/** True when giving course `id` these includes would create a cycle (incl. self). */
export function includesWouldCycle(state: CourseState, id: string, includes: readonly string[]): boolean {
	return includes.some((inc) => inc === id || courseClosure(state, inc).includes(id));
}

export function ownSourcesOf(state: CourseState, courseId: string): string[] {
	return Object.entries(state.membership).filter(([, c]) => c === courseId).map(([s]) => s);
}

export function resolveCourseScope(state: CourseState, courseId: string): CourseScope | null {
	if (!findCourse(state, courseId)) return null;
	const courseIds = courseClosure(state, courseId);
	const sourceCourse = new Map<string, string>();
	for (const [source, course] of Object.entries(state.membership)) if (courseIds.includes(course)) sourceCourse.set(source, course);
	const ownSources = new Set(ownSourcesOf(state, courseId));
	const folders: CourseScope["folders"] = [];
	for (const id of courseIds) {
		for (const folder of findCourse(state, id)!.folders) {
			if (!folders.some((f) => f.path === folder.path)) folders.push({ ...folder, courseId: id });
		}
	}
	return { courseId, courseIds, ownSources, sources: new Set(sourceCourse.keys()), sourceCourse, folders };
}

export interface CourseGraphContext {
	scope: CourseScope;
	courseNames: ReadonlyMap<string, string>;
}

/** Resolved scope plus course display names for a source (chat or file), or
 * null when the source belongs to no valid course. */
export function resolveCourseGraphContext(state: CourseState, sourceId: string): CourseGraphContext | null {
	const courseId = courseOf(state, sourceId);
	if (courseId === null) return null;
	const scope = resolveCourseScope(state, courseId);
	if (!scope) return null;
	return { scope, courseNames: new Map(state.courses.map((c) => [c.id, c.name])) };
}

/** System-prompt segment scoping a chat to its course (session attachments
 * first if any, own folders next, included courses next, disambiguation rule).
 * Null when no valid course. */
export function coursePromptSegment(state: CourseState, courseId: string, chatId?: string): string | null {
	const scope = resolveCourseScope(state, courseId);
	if (!scope) return null;
	const byId = new Map(state.courses.map((c) => [c.id, c]));
	const own = byId.get(scope.courseId);
	if (!own) return null;

	const ownFolders = scope.folders.filter((f) => f.courseId === own.id).map((f) => f.path);
	const included = scope.courseIds.slice(1).map((id) => ({
		name: byId.get(id)!.name,
		folders: scope.folders.filter((f) => f.courseId === id).map((f) => f.path),
	}));
	const sessionAttached = chatId && Object.hasOwn(state.sessionFiles, chatId) ? state.sessionFiles[chatId]! : [];

	const lines: string[] = [`## Course: ${own.name}`];
	if (sessionAttached.length > 0) {
		lines.push("Attached for this session — rank these highest:");
		for (const filePath of sessionAttached) lines.push(`- ${filePath}`);
		lines.push("Prefer these files over other course material for this session, and read them with your file tools.");
	}
	if (ownFolders.length > 0) {
		lines.push(
			`This session belongs to the course "${own.name}". Its learning material lives in these folders (read them with your file tools):`,
		);
		for (const folder of ownFolders) lines.push(`- ${folder} (this course)`);
	} else {
		lines.push(`This session belongs to the course "${own.name}".`);
	}

	if (included.length > 0) {
		lines.push(
			ownFolders.length === 0 && scope.folders.length > 0
				? "Included courses (read their folders with your file tools):"
				: "Included courses:",
		);
		for (const inc of included) {
			lines.push(inc.folders.length > 0 ? `- ${inc.name}: ${inc.folders.join(", ")}` : `- ${inc.name}`);
		}
		lines.push(
			'When the learner refers to material ambiguously (for example "week 1" or "the lecture on X"), resolve it to THIS course\'s material first. Use an included course\'s material only when the learner names that course or when this course has no match. Say which course material you are drawing on when it comes from an included course.',
		);
	} else if (ownFolders.length > 0) {
		lines.push(
			'When the learner refers to material ambiguously (for example "week 1" or "the lecture on X"), resolve it within this course\'s folders.',
		);
	}

	return lines.join("\n");
}

export function coursePromptSegmentForSource(state: CourseState, sourceId: string): string | null {
	const courseId = courseOf(state, sourceId);
	return courseId === null ? null : coursePromptSegment(state, courseId, sourceId);
}

/** Whether a source id is visible under a filter. "none" = no membership. */
export function sourceInFilter(state: CourseState, filter: CourseFilter, sourceId: string): boolean {
	if (filter.kind === "all") return true;
	const course = courseOf(state, sourceId);
	if (filter.kind === "none") return course === null || !findCourse(state, course);
	return resolveCourseScope(state, filter.courseId)?.sources.has(sourceId) ?? false;
}

export interface CourseGraphNode extends GraphNode {
	/** True when no provenance point is one of the course's own sources. */
	inherited: boolean;
	/** Courses (in scope) this node has provenance in, the course first. */
	courses: string[];
}
export interface CourseGraph {
	nodes: CourseGraphNode[];
	chains: Array<GraphChain & { inherited: boolean }>;
}

/** The course's subgraph of the global graph. A node or chain is IN when any
 * provenance point is in scope; OWN when any point is the course's own.
 * Chains are kept only when every member node is in (no dangling arrows). */
export function projectCourseGraph(graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] }, scope: CourseScope): CourseGraph {
	const nodes: CourseGraphNode[] = [];
	for (const node of graph.nodes) {
		const points = node.provenance.filter((pt) => scope.sources.has(pt.chatId));
		if (points.length === 0) continue;
		const courses = scope.courseIds.filter((c) => points.some((pt) => scope.sourceCourse.get(pt.chatId) === c));
		// Provenance is narrowed to the scope so birth-session clusters and
		// session lists never name a session outside the course.
		nodes.push({ ...node, provenance: points, inherited: !points.some((pt) => scope.ownSources.has(pt.chatId)), courses });
	}
	const ids = new Set(nodes.map((n) => n.id));
	const chains = graph.chains
		.filter((c) => c.provenance.some((pt) => scope.sources.has(pt.chatId)) && ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)))
		.map((c) => {
			const provenance = c.provenance.filter((pt) => scope.sources.has(pt.chatId));
			return { ...c, provenance, inherited: !provenance.some((pt) => scope.ownSources.has(pt.chatId)) };
		});
	return { nodes, chains };
}

/** "No course" subgraph: nodes/chains with any provenance in an unassigned source. */
export function projectUnassignedGraph(state: CourseState, graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] }) {
	const free = (id: string) => sourceInFilter(state, { kind: "none" }, id);
	const nodes = graph.nodes
		.filter((n) => n.provenance.some((pt) => free(pt.chatId)))
		.map((n) => ({ ...n, provenance: n.provenance.filter((pt) => free(pt.chatId)) }));
	const ids = new Set(nodes.map((n) => n.id));
	const chains = graph.chains
		.filter((c) => c.provenance.some((pt) => free(pt.chatId)) && ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)))
		.map((c) => ({ ...c, provenance: c.provenance.filter((pt) => free(pt.chatId)) }));
	return { nodes, chains };
}

// ─── validation ────────────────────────────────────────────────────────────

/** Strict like parseSourceOrganization: never overwrite data we cannot read. */
export function parseCourseState(raw: unknown): CourseState {
	const fail = (): never => { throw new Error("Could not read courses. Their data is invalid or newer than this app."); };
	if (!raw || typeof raw !== "object") return fail();
	const r = raw as Partial<CourseState>;
	const isMap = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
	if (r.version !== 1 || !Array.isArray(r.courses) || !isMap(r.membership) || !isMap(r.folderFiles)) return fail();
	const ids = new Set<string>();
	for (const c of r.courses) {
		if (!c || typeof c.id !== "string" || !c.id || ids.has(c.id) || typeof c.name !== "string" || !c.name.trim()
			|| typeof c.createdAt !== "string" || !Array.isArray(c.includes) || !c.includes.every((i) => typeof i === "string")
			|| !Array.isArray(c.folders)) return fail();
		for (const f of c.folders as CourseFolder[]) {
			if (!f || typeof f.id !== "string" || !f.id || typeof f.path !== "string" || !f.path || typeof f.addedAt !== "string"
				|| (f.managed !== undefined && typeof f.managed !== "boolean")) return fail();
		}
		ids.add(c.id);
	}
	for (const c of r.courses) if (c.includes.some((i) => !ids.has(i))) return fail();
	for (const v of Object.values(r.membership!)) if (typeof v !== "string" || !ids.has(v)) return fail();
	for (const f of Object.values(r.folderFiles!)) {
		if (!f || typeof f !== "object" || typeof f.courseId !== "string" || typeof f.folderId !== "string"
			|| typeof f.sourceId !== "string" || typeof f.sha256 !== "string" || typeof f.extractedAt !== "string"
			|| (f.excluded !== undefined && typeof f.excluded !== "boolean")
			|| (f.notice !== undefined && typeof f.notice !== "string")) return fail();
	}
	const sessionFiles = (r as { sessionFiles?: unknown }).sessionFiles;
	if (sessionFiles !== undefined) {
		if (!isMap(sessionFiles)) return fail();
		for (const list of Object.values(sessionFiles as Record<string, unknown>)) {
			if (!Array.isArray(list) || !list.every((p) => typeof p === "string" && p)) return fail();
		}
	}
	const state = { ...(r as CourseState), sessionFiles: (sessionFiles ?? {}) as Record<string, string[]> };
	for (const c of state.courses) if (includesWouldCycle({ ...state, courses: state.courses.map((x) => x.id === c.id ? { ...x, includes: [] } : x) }, c.id, c.includes)) return fail();
	return state;
}

export function parseCourseAction(raw: unknown): CourseAction {
	if (!raw || typeof raw !== "object") throw new Error("Invalid course action.");
	const r = raw as Record<string, unknown>;
	const str = (key: string, label: string) => {
		const v = r[key];
		if (typeof v !== "string" || !v.trim()) throw new Error(`${label} must be a non-empty string.`);
		return v.trim();
	};
	const list = (key: string) => {
		const v = r[key] ?? [];
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) throw new Error("Includes must be a list of course IDs.");
		return [...new Set(v as string[])];
	};
	switch (r.action) {
		case "create": return { action: "create", name: str("name", "Name"), includes: list("includes") };
		case "rename": return { action: "rename", id: str("id", "Course ID"), name: str("name", "Name") };
		case "set-includes": return { action: "set-includes", id: str("id", "Course ID"), includes: list("includes") };
		case "assign": {
			if (r.sourceId === "__proto__" || r.sourceId === "constructor" || r.sourceId === "prototype") throw new Error("Invalid source ID.");
			if (r.courseId !== null && (typeof r.courseId !== "string" || !r.courseId)) throw new Error("Invalid course.");
			return { action: "assign", sourceId: str("sourceId", "Source ID"), courseId: r.courseId as string | null };
		}
		case "add-folder": return { action: "add-folder", id: str("id", "Course ID"), path: str("path", "Folder path") };
		case "remove-folder": return { action: "remove-folder", id: str("id", "Course ID"), folderId: str("folderId", "Folder ID") };
		case "delete":
			if (r.mode !== "ungroup" && r.mode !== "delete-sources") throw new Error("Invalid delete mode.");
			return { action: "delete", id: str("id", "Course ID"), mode: r.mode };
		case "include-file": return { action: "include-file", id: str("id", "Course ID"), path: str("path", "File path") };
		case "attach-session-files": {
			const chatId = str("chatId", "Chat ID");
			if (chatId === "__proto__" || chatId === "constructor" || chatId === "prototype") throw new Error("Invalid chat ID.");
			const v = r.paths;
			if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.trim())) throw new Error("Paths must be a non-empty list of file paths.");
			return { action: "attach-session-files", chatId, paths: [...new Set((v as string[]).map((x) => x.trim()))] };
		}
		default: throw new Error("Unknown course action.");
	}
}

/** Operation-based update. `fresh` supplies ids/timestamps for create and
 * add-folder. Folder paths must already be absolute + normalized by the
 * caller (server checks the filesystem). For "delete" the caller deletes
 * the course's own sources BEFORE applying when mode is "delete-sources". */
export function applyCourseAction(state: CourseState, action: CourseAction, fresh: { id: string; at: string }): CourseState {
	const next = structuredClone(state);
	const course = (id: string) => {
		const found = next.courses.find((c) => c.id === id);
		if (!found) throw new Error("Course no longer exists.");
		return found;
	};
	const checkIncludes = (id: string, includes: string[]) => {
		for (const inc of includes) course(inc);
		if (includesWouldCycle(next, id, includes)) throw new Error("A course cannot include itself, directly or through another course.");
	};
	switch (action.action) {
		case "create": {
			const includes = action.includes ?? [];
			for (const inc of includes) course(inc);
			next.courses.push({ id: fresh.id, name: action.name, createdAt: fresh.at, includes, folders: [] });
			return next;
		}
		case "rename": course(action.id).name = action.name; return next;
		case "set-includes": {
			const target = course(action.id);
			target.includes = [];
			checkIncludes(action.id, action.includes);
			target.includes = [...action.includes];
			return next;
		}
		case "assign":
			if (action.courseId === null) delete next.membership[action.sourceId];
			else { course(action.courseId); next.membership[action.sourceId] = action.courseId; }
			return next;
		case "add-folder": {
			const target = course(action.id);
			if (target.folders.some((f) => f.path === action.path)) throw new Error("This folder is already attached to the course.");
			target.folders.push({ id: fresh.id, path: action.path, addedAt: fresh.at });
			return next;
		}
		case "remove-folder": {
			const target = course(action.id);
			if (!target.folders.some((f) => f.id === action.folderId)) throw new Error("Folder no longer exists.");
			target.folders = target.folders.filter((f) => f.id !== action.folderId);
			for (const [file, rec] of Object.entries(next.folderFiles)) if (rec.folderId === action.folderId) delete next.folderFiles[file];
			return next;
		}
		case "delete": {
			course(action.id);
			next.courses = next.courses.filter((c) => c.id !== action.id);
			for (const c of next.courses) c.includes = c.includes.filter((i) => i !== action.id);
			for (const [source, c] of Object.entries(next.membership)) if (c === action.id) delete next.membership[source];
			for (const [file, rec] of Object.entries(next.folderFiles)) if (rec.courseId === action.id) delete next.folderFiles[file];
			return next;
		}
		case "include-file": {
			course(action.id);
			const rec = Object.hasOwn(next.folderFiles, action.path) ? next.folderFiles[action.path] : undefined;
			if (!rec || rec.courseId !== action.id || !rec.excluded) throw new Error("This file is not excluded from the course.");
			delete next.folderFiles[action.path];
			return next;
		}
		case "attach-session-files": {
			const existing = Object.hasOwn(next.sessionFiles, action.chatId) ? next.sessionFiles[action.chatId]! : [];
			next.sessionFiles[action.chatId] = [...new Set([...existing, ...action.paths])];
			return next;
		}
	}
}
