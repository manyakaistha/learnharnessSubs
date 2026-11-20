import assert from "node:assert/strict";
import { it } from "node:test";
import {
	applyCourseAction, courseClosure, emptyCourseState, includesWouldCycle, parseCourseAction, parseCourseState,
	projectCourseGraph, projectUnassignedGraph, resolveCourseScope, sourceInFilter,
} from "../src/core/courses.ts";
import type { CourseState } from "../src/core/contracts/courses.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";

let n = 0;
const fresh = () => ({ id: `crs_${++n}`, at: "2026-11-20T00:00:00Z" });
function build(): CourseState {
	let s = emptyCourseState();
	s = applyCourseAction(s, { action: "create", name: "CV" }, { id: "cv", at: "t" });
	s = applyCourseAction(s, { action: "create", name: "DL" }, { id: "dl", at: "t" });
	s = applyCourseAction(s, { action: "create", name: "Robotics", includes: ["cv"] }, { id: "rob", at: "t" });
	s = applyCourseAction(s, { action: "create", name: "VLA", includes: ["rob", "dl"] }, { id: "vla", at: "t" });
	for (const [src, c] of [["c_cv", "cv"], ["c_dl", "dl"], ["c_rob", "rob"], ["c_vla", "vla"]] as const) s = applyCourseAction(s, { action: "assign", sourceId: src, courseId: c }, fresh());
	return s;
}
const node = (id: string, ...chats: string[]): GraphNode => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: chats.map((chatId) => ({ chatId, messageId: "m" })) } as GraphNode);
const chain = (id: string, premises: string[], conclusion: string, ...chats: string[]): GraphChain => ({ id, premises, conclusion, createdAt: "t", provenance: chats.map((chatId) => ({ chatId, messageId: "m" })) });

it("includes resolve transitively and reject cycles", () => {
	const s = build();
	assert.deepEqual(courseClosure(s, "vla"), ["vla", "rob", "dl", "cv"]);
	assert.equal(includesWouldCycle(s, "cv", ["vla"]), true);
	assert.equal(includesWouldCycle(s, "cv", ["cv"]), true);
	assert.equal(includesWouldCycle(s, "dl", ["cv"]), false);
	assert.throws(() => applyCourseAction(s, { action: "set-includes", id: "cv", includes: ["vla"] }, fresh()), /cannot include itself/);
});

it("scope covers own + included sources; projection marks inherited", () => {
	const s = build();
	const scope = resolveCourseScope(s, "vla")!;
	assert.deepEqual([...scope.ownSources], ["c_vla"]);
	assert.deepEqual([...scope.sources].sort(), ["c_cv", "c_dl", "c_rob", "c_vla"]);
	const graph = {
		nodes: [node("a", "c_vla"), node("b", "c_cv"), node("shared", "c_cv", "c_vla"), node("x", "free")],
		chains: [chain("k1", ["b"], "a", "c_vla"), chain("k2", ["x"], "a", "c_vla"), chain("k3", ["b"], "shared", "c_cv")],
	};
	const g = projectCourseGraph(graph, scope);
	assert.deepEqual(g.nodes.map((x) => [x.id, x.inherited, x.courses]), [["a", false, ["vla"]], ["b", true, ["cv"]], ["shared", false, ["vla", "cv"]]]);
	assert.deepEqual(g.chains.map((c) => [c.id, c.inherited]), [["k1", false], ["k3", true]], "chains with an out-of-scope member drop");
	assert.deepEqual(projectUnassignedGraph(s, graph).nodes.map((x) => x.id), ["x"]);
	assert.equal(sourceInFilter(s, { kind: "none" }, "free"), true);
	assert.equal(sourceInFilter(s, { kind: "course", courseId: "cv" }, "c_vla"), false);
	assert.equal(sourceInFilter(s, { kind: "all" }, "c_vla"), true);
});

it("delete ungroups members, drops includes, and the state round-trips the parser", () => {
	let s = build();
	s = applyCourseAction(s, { action: "add-folder", id: "cv", path: "/notes/cv" }, { id: "f1", at: "t" });
	s.folderFiles["/notes/cv/w1.md"] = { courseId: "cv", folderId: "f1", sourceId: "src_1", sha256: "ab", extractedAt: "t" };
	assert.equal(resolveCourseScope(s, "vla")!.folders[0]!.courseId, "cv");
	s = applyCourseAction(s, { action: "delete", id: "cv", mode: "ungroup" }, fresh());
	assert.equal(s.membership.c_cv, undefined);
	assert.deepEqual(s.courses.find((c) => c.id === "rob")!.includes, []);
	assert.deepEqual(s.folderFiles, {});
	assert.deepEqual(parseCourseState(JSON.parse(JSON.stringify(s))), s);
	assert.throws(() => parseCourseState({ ...s, membership: { x: "missing" } }), /invalid/);
	assert.throws(() => parseCourseState({ ...s, version: 2 }), /invalid/);
});

it("actions parse strictly", () => {
	assert.deepEqual(parseCourseAction({ action: "create", name: " VLA ", includes: ["a", "a"] }), { action: "create", name: "VLA", includes: ["a"] });
	assert.deepEqual(parseCourseAction({ action: "assign", sourceId: "c1", courseId: null }), { action: "assign", sourceId: "c1", courseId: null });
	assert.throws(() => parseCourseAction({ action: "delete", id: "a", mode: "nuke" }), /mode/);
	assert.throws(() => parseCourseAction({ action: "rename", id: "a", name: " " }), /Name/);
});
