import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-agent-scope-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { courseStore } = await import("../src/store/courses.ts");
const { fileAccessPolicy } = await import("../src/server/file-access.ts");
const { applyCourseAction, coursePromptSegment, emptyCourseState, resolveCourseScope } = await import("../src/core/courses.ts");
const { graphSessionIndex, graphSessionPropositions } = await import("../src/core/graph.ts");

const cvDir = fs.mkdtempSync(path.join(root, "cv-"));
const vlaDir = fs.mkdtempSync(path.join(root, "vla-"));
let s = emptyCourseState();
s = applyCourseAction(s, { action: "create", name: "CV" }, { id: "cv", at: "t" });
s = applyCourseAction(s, { action: "create", name: "VLA", includes: ["cv"] }, { id: "vla", at: "t" });
s = applyCourseAction(s, { action: "create", name: "Empty" }, { id: "empty", at: "t" });
s = applyCourseAction(s, { action: "add-folder", id: "cv", path: cvDir }, { id: "f_cv", at: "t" });
s = applyCourseAction(s, { action: "add-folder", id: "vla", path: vlaDir }, { id: "f_vla", at: "t" });
for (const [src, c] of [["chat_cv", "cv"], ["chat_vla", "vla"], ["chat_empty", "empty"]] as const) s = applyCourseAction(s, { action: "assign", sourceId: src, courseId: c }, { id: "", at: "t" });
courseStore.write(s);

it("course chats get exactly own + included folders; no-course chats keep the global policy", () => {
	assert.deepEqual(fileAccessPolicy("chat_vla"), { restricted: true, folders: [path.resolve(vlaDir), path.resolve(cvDir)] });
	assert.deepEqual(fileAccessPolicy("chat_cv"), { restricted: true, folders: [path.resolve(cvDir)] });
	assert.deepEqual(fileAccessPolicy("chat_empty"), { restricted: true, folders: [] }, "a course without folders grants no learner-source access");
	assert.deepEqual(fileAccessPolicy("chat_free"), fileAccessPolicy(), "unassigned chat = global setting, unchanged");
});

it("prompt segment lists own folders first, then included courses, with the own-course-first rule", () => {
	const text = coursePromptSegment(s, "vla")!;
	assert.match(text, /^## Course: VLA/);
	assert.ok(text.indexOf(vlaDir) < text.indexOf(cvDir), "own folder listed before included");
	assert.match(text, new RegExp(`- CV: ${cvDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(text, /THIS course's material first/);
	assert.equal(coursePromptSegment(s, "missing"), null);
});

it("prober graph session index is limited to the course scope, own sessions first", () => {
	const node = (id: string, ...chats: string[]) => ({ id, name: id, statement: id, aliases: [], createdAt: "t", provenance: chats.map((chatId) => ({ chatId, messageId: "m" })) });
	const nodes = [node("n_cv", "chat_cv"), node("n_vla", "chat_vla"), node("n_free", "chat_free")];
	const chats = ["chat_cv", "chat_vla", "chat_free"].map((id) => ({ id, title: id, kind: "teach", createdAt: "2026-11-01", updatedAt: id === "chat_cv" ? "2026-11-20" : "2026-11-02" }));
	const deps = {
		graphStore: { readNodes: () => nodes, readChains: () => [], readSources: () => [] },
		chatStore: { listChats: () => chats },
	} as unknown as Parameters<typeof graphSessionIndex>[0];
	const scope = resolveCourseScope(s, "vla")!;
	assert.deepEqual(graphSessionIndex(deps, scope).map((e) => e.id), ["chat_vla", "chat_cv"], "own first despite older activity; out-of-scope dropped");
	assert.deepEqual(graphSessionIndex(deps).map((e) => e.id).sort(), ["chat_cv", "chat_free", "chat_vla"], "no scope = global");
	assert.deepEqual(graphSessionPropositions(deps, "chat_free", scope), []);
});
