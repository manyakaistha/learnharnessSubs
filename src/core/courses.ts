import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import type { Course, CourseAction, CourseFilter, CourseFolder, CourseScope, CourseState } from "./contracts/courses.ts";

/** Pure course logic (contracts/courses.ts). No fs, no ids minted here:
 * callers pass fresh ids and timestamps, like source-organization.ts. */

export const emptyCourseState = (): CourseState => ({ version: 1, courses: [], membership: {}, folderFiles: {} });

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
		nodes.push({ ...node, inherited: !points.some((pt) => scope.ownSources.has(pt.chatId)), courses });
	}
	const ids = new Set(nodes.map((n) => n.id));
	const chains = graph.chains
		.filter((c) => c.provenance.some((pt) => scope.sources.has(pt.chatId)) && ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)))
		.map((c) => ({ ...c, inherited: !c.provenance.some((pt) => scope.ownSources.has(pt.chatId)) }));
	return { nodes, chains };
}

/** "No course" subgraph: nodes/chains with any provenance in an unassigned source. */
export function projectUnassignedGraph(state: CourseState, graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] }) {
	const free = (id: string) => sourceInFilter(state, { kind: "none" }, id);
	const nodes = graph.nodes.filter((n) => n.provenance.some((pt) => free(pt.chatId)));
	const ids = new Set(nodes.map((n) => n.id));
	const chains = graph.chains.filter((c) => c.provenance.some((pt) => free(pt.chatId)) && ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)));
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
			if (!f || typeof f.id !== "string" || !f.id || typeof f.path !== "string" || !f.path || typeof f.addedAt !== "string") return fail();
		}
		ids.add(c.id);
	}
	for (const c of r.courses) if (c.includes.some((i) => !ids.has(i))) return fail();
	for (const v of Object.values(r.membership!)) if (typeof v !== "string" || !ids.has(v)) return fail();
	for (const f of Object.values(r.folderFiles!)) {
		if (!f || typeof f !== "object" || typeof f.courseId !== "string" || typeof f.folderId !== "string"
			|| typeof f.sourceId !== "string" || typeof f.sha256 !== "string" || typeof f.extractedAt !== "string") return fail();
	}
	const state = r as CourseState;
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
			if (r.courseId !== null && (typeof r.courseId !== "string" || !r.courseId)) throw new Error("Invalid course.");
			return { action: "assign", sourceId: str("sourceId", "Source ID"), courseId: r.courseId as string | null };
		}
		case "add-folder": return { action: "add-folder", id: str("id", "Course ID"), path: str("path", "Folder path") };
		case "remove-folder": return { action: "remove-folder", id: str("id", "Course ID"), folderId: str("folderId", "Folder ID") };
		case "delete":
			if (r.mode !== "ungroup" && r.mode !== "delete-sources") throw new Error("Invalid delete mode.");
			return { action: "delete", id: str("id", "Course ID"), mode: r.mode };
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
	}
}
