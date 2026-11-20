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
const { setFileAccessPolicy, resolvePolicy, guardSourcePath } = await import("../src/agent/tools/file-access.ts");
const { createReadTool } = await import("../src/agent/tools/read.ts");
const { createLsTool } = await import("../src/agent/tools/ls.ts");
const { createFindTool } = await import("../src/agent/tools/find.ts");
const { createGrepTool } = await import("../src/agent/tools/grep.ts");

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

it("sessionFiles grants access for that chat only and works with read, ls, find, and grep without breaking defaults", async () => {
	const outsideDir = fs.mkdtempSync(path.join(root, "outside-"));
	const attachedFile = path.join(outsideDir, "handout.md");
	const siblingFile = path.join(outsideDir, "secret.md");
	const cvNote = path.join(cvDir, "cv-note.md");
	fs.writeFileSync(attachedFile, "Session handout needle\n");
	fs.writeFileSync(siblingFile, "Sibling secret needle\n");
	fs.writeFileSync(cvNote, "CV folder needle\n");

	let withSession = applyCourseAction(s, { action: "attach-session-files", chatId: "chat_cv", paths: [attachedFile] }, { id: "", at: "t" });
	withSession = applyCourseAction(withSession, { action: "attach-session-files", chatId: "chat_empty", paths: [attachedFile] }, { id: "", at: "t" });
	// An entry for a no-course chat must never affect its policy
	withSession = applyCourseAction(withSession, { action: "attach-session-files", chatId: "chat_free", paths: [attachedFile] }, { id: "", at: "t" });
	courseStore.write(withSession);
	setFileAccessPolicy(fileAccessPolicy);

	try {
		assert.deepEqual(fileAccessPolicy("chat_cv"), { restricted: true, folders: [path.resolve(cvDir), path.resolve(attachedFile)] });
		assert.deepEqual(fileAccessPolicy("chat_vla"), { restricted: true, folders: [path.resolve(vlaDir), path.resolve(cvDir)] });
		assert.deepEqual(fileAccessPolicy("chat_empty"), { restricted: true, folders: [path.resolve(attachedFile)] });
		assert.deepEqual(fileAccessPolicy("chat_free"), fileAccessPolicy(), "no-course chat ignores sessionFiles");

		const resolved = resolvePolicy(fileAccessPolicy("chat_cv"));
		const realAttached = fs.realpathSync.native(attachedFile);
		assert.equal(guardSourcePath(attachedFile, resolved), realAttached);
		assert.throws(() => guardSourcePath(siblingFile, resolved), /Access denied/);
		assert.throws(() => guardSourcePath(path.join(attachedFile, "child"), resolved), /Access denied/);

		// Tools for chat_cv: read attached file, deny sibling; ls/find/grep with no path work when a root is a file
		const read = createReadTool(undefined, "chat_cv");
		const ls = createLsTool("chat_cv");
		const find = createFindTool("chat_cv");
		const grep = createGrepTool("chat_cv");

		const readRes = await read.execute!("1", { path: attachedFile });
		assert.match((readRes.content[0] as { text: string }).text, /Session handout needle/);
		await assert.rejects(read.execute!("2", { path: siblingFile }), /Access denied/);
		await assert.rejects(createReadTool(undefined, "chat_vla").execute!("3", { path: attachedFile }), /Access denied/);

		const lsOut = (await ls.execute!("4", {})).content[0] as { text: string };
		assert.ok(lsOut.text.includes(realAttached));
		await assert.rejects(ls.execute!("4b", { path: attachedFile }), /Not a directory/);

		const findOut = (await find.execute!("5", { pattern: "*.md" })).content[0] as { text: string };
		assert.ok(findOut.text.includes(realAttached));
		assert.ok(findOut.text.includes(fs.realpathSync.native(cvNote)));
		assert.ok(!findOut.text.includes(fs.realpathSync.native(siblingFile)));

		const grepOut = (await grep.execute!("6", { pattern: "needle" })).content[0] as { text: string };
		assert.ok(grepOut.text.includes(`${realAttached}:1: Session handout needle`));
		assert.ok(grepOut.text.includes(`${fs.realpathSync.native(cvNote)}:1: CV folder needle`));
		assert.ok(!grepOut.text.includes("Sibling secret"));

		// Course with ONLY a file root (chat_empty) also works for ls/find/grep with no path
		const emptyFind = (await createFindTool("chat_empty").execute!("7", { pattern: "*.md" })).content[0] as { text: string };
		assert.equal(emptyFind.text, realAttached);
		const emptyGrep = (await createGrepTool("chat_empty").execute!("8", { pattern: "needle", glob: "*.txt" })).content[0] as { text: string };
		assert.equal(emptyGrep.text, "No matches found");
	} finally {
		setFileAccessPolicy(fileAccessPolicy);
		courseStore.write(s);
	}
});
