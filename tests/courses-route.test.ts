import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-route-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const coursesRoute = await import("../app/api/courses/route.ts");
const courseFilesRoute = await import("../app/api/courses/files/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const chatByIdRoute = await import("../app/api/chats/[id]/route.ts");
const graphRoute = await import("../app/api/graph/route.ts");
const sourcesRoute = await import("../app/api/graph/sources/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { courseFileSourceId, setCourseExtractorForTests, waitForCourseScanForTests } = await import("../src/server/course-sources.ts");
const { COURSE_FILES_DIR, COURSES_FILE } = await import("../config.ts");
const { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES } = await import("../lib/notes-import-limits.ts");

beforeEach(() => {
	setCourseExtractorForTests(null);
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n");
});

const postCourse = (body: unknown) =>
	coursesRoute.POST(
		new Request("http://localhost/api/courses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);

it("GET is a non-writing read and supports create, rename, includes cycle rejection, assign, rescan", async () => {
	const empty = await coursesRoute.GET();
	assert.equal(empty.status, 200);
	assert.deepEqual(await empty.json(), { courses: [], membership: {} });
	assert.equal(fs.existsSync(COURSES_FILE), false);

	const r1 = await postCourse({ action: "create", name: "  CV  " });
	assert.equal(r1.status, 200);
	const v1 = await r1.json();
	const cv = v1.courses[0];
	assert.ok(cv.id.startsWith("crs_"));
	assert.equal(cv.name, "CV");

	const r2 = await postCourse({ action: "create", name: "VLA", includes: [cv.id] });
	assert.equal(r2.status, 200);
	const v2 = await r2.json();
	const vla = v2.courses.find((c: { name: string }) => c.name === "VLA");
	assert.deepEqual(vla.includedCourseIds, [cv.id]);

	const renamed = await postCourse({ action: "rename", id: cv.id, name: "Computer Vision" });
	assert.equal(renamed.status, 200);
	assert.equal((await renamed.json()).courses.find((c: { id: string }) => c.id === cv.id).name, "Computer Vision");

	// Cycle rejection (direct self and indirect)
	assert.equal((await postCourse({ action: "set-includes", id: cv.id, includes: [cv.id] })).status, 400);
	const cycleRes = await postCourse({ action: "set-includes", id: cv.id, includes: [vla.id] });
	assert.equal(cycleRes.status, 400);
	assert.match((await cycleRes.json()).error, /cannot include itself/);

	// Assign and unassign
	const assigned = await postCourse({ action: "assign", sourceId: "src_1", courseId: cv.id });
	assert.equal(assigned.status, 200);
	const assignedJson = await assigned.json();
	assert.equal(assignedJson.membership.src_1, cv.id);
	assert.deepEqual(assignedJson.courses.find((c: { id: string }) => c.id === cv.id).ownSourceIds, ["src_1"]);

	const unassigned = await postCourse({ action: "assign", sourceId: "src_1", courseId: null });
	assert.equal(unassigned.status, 200);
	assert.deepEqual((await unassigned.json()).membership, {});

	// Rescan existing vs unknown
	assert.equal((await postCourse({ action: "rescan", id: cv.id })).status, 200);
	assert.equal((await postCourse({ action: "rescan", id: "crs_missing" })).status, 400);
});

it("add-folder validates absolute existing directories, normalizes paths, expands ~, and rejects bad paths", async () => {
	const created = await (await postCourse({ action: "create", name: "Robotics" })).json();
	const courseId = created.courses[0].id as string;

	const folder = path.join(root, "notes", "week1");
	fs.mkdirSync(folder, { recursive: true });
	const filePath = path.join(root, "notes", "file.md");
	fs.writeFileSync(filePath, "# hi");

	// Relative path rejected
	assert.equal((await postCourse({ action: "add-folder", id: courseId, path: "relative/path" })).status, 400);
	// File instead of directory rejected
	assert.equal((await postCourse({ action: "add-folder", id: courseId, path: filePath })).status, 400);
	// Missing path (including ~ expansion) rejected as non-existent (not as relative)
	const missingHome = await postCourse({ action: "add-folder", id: courseId, path: "~/__lh_missing_course_dir_test__" });
	assert.equal(missingHome.status, 400);
	assert.match((await missingHome.json()).error, /does not exist/);

	// Unnormalized absolute path succeeds and normalizes via path.resolve
	const unnormalized = path.join(root, "notes", "week1", "..", "week1") + "/";
	const added = await postCourse({ action: "add-folder", id: courseId, path: unnormalized });
	assert.equal(added.status, 200);
	const addedJson = await added.json();
	const folderRec = addedJson.courses[0].folders[0];
	assert.ok(folderRec.id.startsWith("cfld_"));
	assert.equal(folderRec.path, path.resolve(folder));

	// Duplicate folder rejected
	assert.equal((await postCourse({ action: "add-folder", id: courseId, path: folder })).status, 400);

	// Nested or parent folders overlap this or another course's folder
	assert.equal((await postCourse({ action: "add-folder", id: courseId, path: path.join(root, "notes") })).status, 400);
	const other = (await (await postCourse({ action: "create", name: "Other" })).json()).courses.find((c: { name: string }) => c.name === "Other").id;
	fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
	const overlap = await postCourse({ action: "add-folder", id: other, path: path.join(folder, "sub") });
	assert.equal(overlap.status, 400);
	assert.match((await overlap.json()).error, /Robotics/);
	await postCourse({ action: "delete", id: other, mode: "ungroup" });

	// Remove folder
	const removed = await postCourse({ action: "remove-folder", id: courseId, folderId: folderRec.id });
	assert.equal(removed.status, 200);
	assert.deepEqual((await removed.json()).courses[0].folders, []);
});

it("delete supports both ungroup and delete-sources modes", async () => {
	// Ungroup mode keeps chats, notes sources, and graph knowledge
	const c1 = (await (await postCourse({ action: "create", name: "UngroupCourse" })).json()).courses[0].id as string;
	const chat1 = stores.chatStore.createChat("Kept session");
	stores.graphStore.upsertSource({ id: "src_kept1", filePath: "/tmp/kept1.md", importedAt: "2026-11-20T00:00:00Z" });
	stores.graphStore.appendNode({
		id: "n_kept1",
		name: "Kept",
		statement: "Kept fact.",
		aliases: [],
		createdAt: "2026-11-20T00:00:00Z",
		provenance: [{ chatId: chat1.id, messageId: "m1" }],
	});
	await postCourse({ action: "assign", sourceId: chat1.id, courseId: c1 });
	await postCourse({ action: "assign", sourceId: "src_kept1", courseId: c1 });

	const delUngroup = await postCourse({ action: "delete", id: c1, mode: "ungroup" });
	assert.equal(delUngroup.status, 200);
	assert.deepEqual(await delUngroup.json(), { courses: [], membership: {} });
	assert.ok(stores.chatStore.getChat(chat1.id));
	assert.equal(stores.graphStore.readSources().length, 1);
	assert.equal(stores.graphStore.readNodes().length, 1);

	// Delete-sources mode deletes the course's own chats, src_ files, and graph traces
	const c2 = (await (await postCourse({ action: "create", name: "PurgeCourse" })).json()).courses[0].id as string;
	const chat2 = stores.chatStore.createChat("Deleted session");
	stores.graphStore.upsertSource({ id: "src_del2", filePath: "/tmp/del2.md", importedAt: "2026-11-20T00:00:00Z" });
	stores.graphStore.appendNode({
		id: "n_del2",
		name: "Deleted",
		statement: "Deleted fact.",
		aliases: [],
		createdAt: "2026-11-20T00:00:00Z",
		provenance: [{ chatId: chat2.id, messageId: "m1" }, { chatId: "src_del2", messageId: "" }],
	});
	await postCourse({ action: "assign", sourceId: chat2.id, courseId: c2 });
	await postCourse({ action: "assign", sourceId: "src_del2", courseId: c2 });

	const delPurge = await postCourse({ action: "delete", id: c2, mode: "delete-sources" });
	assert.equal(delPurge.status, 200);
	assert.equal(stores.chatStore.getChat(chat2.id), null);
	assert.ok(!stores.graphStore.readSources().some((s) => s.id === "src_del2"));
	assert.ok(!stores.graphStore.readNodes().some((n) => n.id === "n_del2"));
	// Kept session from earlier stays untouched
	assert.ok(stores.chatStore.getChat(chat1.id));
});

it("POST /api/chats assigns courseId when valid, rejects unknown courseId with 400, and GET /api/chats includes courseId", async () => {
	const c1 = (await (await postCourse({ action: "create", name: "Math" })).json()).courses[0].id as string;

	// Unknown courseId -> 400 without creating an orphan chat
	const bad = await chatsRoute.POST(
		new Request("http://localhost/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Should fail", courseId: "crs_nonexistent" }),
		}),
	);
	assert.equal(bad.status, 400);
	assert.equal(stores.chatStore.listChats().length, 0);

	// Valid courseId (teach and practice)
	const goodTeach = await chatsRoute.POST(
		new Request("http://localhost/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Linear algebra", courseId: c1 }),
		}),
	);
	assert.equal(goodTeach.status, 200);
	const teachId = (await goodTeach.json()).id as string;

	const goodPractice = await chatsRoute.POST(
		new Request("http://localhost/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Eigenvalues drill", kind: "practice", courseId: c1 }),
		}),
	);
	assert.equal(goodPractice.status, 200);
	const practiceId = (await goodPractice.json()).id as string;

	const unassigned = await chatsRoute.POST(
		new Request("http://localhost/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Free session", courseId: null }),
		}),
	);
	assert.equal(unassigned.status, 200);
	const freeId = (await unassigned.json()).id as string;

	const listRes = await chatsRoute.GET();
	assert.equal(listRes.status, 200);
	const { chats } = (await listRes.json()) as { chats: Array<{ id: string; courseId: string | null }> };
	assert.equal(chats.find((c) => c.id === teachId)?.courseId, c1);
	assert.equal(chats.find((c) => c.id === practiceId)?.courseId, c1);
	assert.equal(chats.find((c) => c.id === freeId)?.courseId, null);
});

it("GET /api/graph and GET /api/graph/sources support ?course=<id>, ?course=none, and 404 on unknown course", async () => {
	const cvId = (await (await postCourse({ action: "create", name: "CV" })).json()).courses[0].id as string;
	const vlaId = (await (await postCourse({ action: "create", name: "VLA", includes: [cvId] })).json()).courses.find((c: { name: string }) => c.name === "VLA").id as string;

	const cvChat = stores.chatStore.createChat("Lecture 3");
	const vlaChat = stores.chatStore.createChat("VLA Policies");
	const freeChat = stores.chatStore.createChat("Unassigned Chat");
	stores.graphStore.upsertSource({ id: "src_cv_notes", filePath: "/notes/cv/slides.md", importedAt: "2026-11-20T00:00:00Z" });

	await postCourse({ action: "assign", sourceId: cvChat.id, courseId: cvId });
	await postCourse({ action: "assign", sourceId: "src_cv_notes", courseId: cvId });
	await postCourse({ action: "assign", sourceId: vlaChat.id, courseId: vlaId });

	// 3 propositions born in CV Lecture 3 -> forms a birth-session cluster
	for (const id of ["n_cv1", "n_cv2", "n_cv3"]) {
		stores.graphStore.appendNode({
			id,
			name: id,
			statement: `${id} statement`,
			aliases: [],
			createdAt: "2026-11-20T00:00:00Z",
			provenance: [{ chatId: cvChat.id, messageId: "m1" }],
		});
	}
	// Shared proposition in CV and VLA -> own (not inherited) in VLA
	stores.graphStore.appendNode({
		id: "n_shared",
		name: "Shared",
		statement: "Shared statement",
		aliases: [],
		createdAt: "2026-11-20T00:00:00Z",
		provenance: [{ chatId: cvChat.id, messageId: "m2" }, { chatId: vlaChat.id, messageId: "m1" }],
	});
	// VLA own nodes + multi-premise chain from CV + VLA
	stores.graphStore.appendNode({
		id: "n_vla1",
		name: "VLA1",
		statement: "VLA1 statement",
		aliases: [],
		createdAt: "2026-11-20T00:00:00Z",
		provenance: [{ chatId: vlaChat.id, messageId: "m2" }],
	});
	stores.graphStore.appendChain({
		id: "arg_vla_imp",
		premises: ["n_cv1", "n_shared"],
		conclusion: "n_vla1",
		createdAt: "2026-11-20T00:00:00Z",
		provenance: [{ chatId: vlaChat.id, messageId: "m3" }],
	});
	// Free unassigned node
	stores.graphStore.appendNode({
		id: "n_free",
		name: "Free",
		statement: "Free statement",
		aliases: [],
		createdAt: "2026-11-20T00:00:00Z",
		provenance: [{ chatId: freeChat.id, messageId: "m1" }],
	});

	// Unfiltered graph: no inherited / courses properties added
	const allRes = await graphRoute.GET(new Request("http://localhost/api/graph"));
	assert.equal(allRes.status, 200);
	const allSnap = await allRes.json();
	assert.equal(allSnap.propositions.length, 6);
	assert.equal("inherited" in allSnap.nodes[0], false);
	assert.equal("courses" in allSnap.nodes[0], false);

	// Scoped graph for VLA: includes CV's nodes (inherited) + VLA's nodes (own), cluster label prefixed
	const vlaRes = await graphRoute.GET(new Request(`http://localhost/api/graph?course=${vlaId}`));
	assert.equal(vlaRes.status, 200);
	const vlaSnap = await vlaRes.json();
	assert.ok(!vlaSnap.propositions.some((n: { id: string }) => n.id === "n_free"));
	const cv1 = vlaSnap.nodes.find((n: { id: string }) => n.id === "n_cv1");
	assert.equal(cv1.inherited, true);
	assert.deepEqual(cv1.courses, [cvId]);
	const shared = vlaSnap.nodes.find((n: { id: string }) => n.id === "n_shared");
	assert.equal(shared.inherited, false);
	assert.deepEqual(shared.courses, [vlaId, cvId]);
	const imp = vlaSnap.nodes.find((n: { id: string }) => n.id === "arg_vla_imp");
	assert.equal(imp.inherited, false);
	assert.deepEqual(imp.courses, [vlaId]);
	const cvCluster = vlaSnap.clusters.find((c: { id: string }) => c.id === cvChat.id);
	assert.equal(cvCluster.label, "CV · Lecture 3");

	// Scoped graph for CV itself: label is NOT prefixed
	const cvRes = await graphRoute.GET(new Request(`http://localhost/api/graph?course=${cvId}`));
	assert.equal(cvRes.status, 200);
	const cvSnap = await cvRes.json();
	assert.equal(cvSnap.clusters.find((c: { id: string }) => c.id === cvChat.id).label, "Lecture 3");

	// Scoped graph for ?course=none
	const noneRes = await graphRoute.GET(new Request("http://localhost/api/graph?course=none"));
	assert.equal(noneRes.status, 200);
	const noneSnap = await noneRes.json();
	assert.deepEqual(noneSnap.propositions.map((n: { id: string }) => n.id), ["n_free"]);

	// Unknown course -> 404
	assert.equal((await graphRoute.GET(new Request("http://localhost/api/graph?course=crs_unknown"))).status, 404);

	// Scoped sources endpoint
	const vlaSourcesRes = await sourcesRoute.GET(new Request(`http://localhost/api/graph/sources?course=${vlaId}`));
	assert.equal(vlaSourcesRes.status, 200);
	const vlaSources = await vlaSourcesRes.json();
	assert.deepEqual(
		vlaSources.sources.map((s: { id: string }) => s.id).sort(),
		[cvChat.id, "src_cv_notes", vlaChat.id].sort(),
	);

	const noneSourcesRes = await sourcesRoute.GET(new Request("http://localhost/api/graph/sources?course=none"));
	assert.equal(noneSourcesRes.status, 200);
	assert.deepEqual((await noneSourcesRes.json()).sources.map((s: { id: string }) => s.id), [freeChat.id]);

	assert.equal((await sourcesRoute.GET(new Request("http://localhost/api/graph/sources?course=crs_unknown"))).status, 404);
});

it("source deletion removes membership and marks folderFiles entries excluded in courses.json", async () => {
	const cId = (await (await postCourse({ action: "create", name: "Physics" })).json()).courses[0].id as string;
	const chatKeep = stores.chatStore.createChat("Keep chat");
	const chatDrop = stores.chatStore.createChat("Drop chat");
	const chatRouteDel = stores.chatStore.createChat("Route deleted chat");
	stores.graphStore.upsertSource({ id: "src_file1", filePath: "/tmp/file1.md", importedAt: "2026-11-20T00:00:00Z" });

	for (const id of [chatKeep.id, chatDrop.id, chatRouteDel.id, "src_file1"]) {
		await postCourse({ action: "assign", sourceId: id, courseId: cId });
	}
	const attachedSessionFile = path.join(root, "session-attached.md");
	fs.writeFileSync(attachedSessionFile, "# Attached");
	for (const id of [chatKeep.id, chatDrop.id, chatRouteDel.id]) {
		await postCourse({ action: "attach-session-files", chatId: id, paths: [attachedSessionFile] });
	}
	const stateWithFolderFile = stores.courseStore.read();
	stateWithFolderFile.folderFiles["/tmp/file1.md"] = {
		courseId: cId,
		folderId: "cfld_1",
		sourceId: "src_file1",
		sha256: "abc",
		extractedAt: "2026-11-20T00:00:00Z",
	};
	stores.courseStore.write(stateWithFolderFile);

	// Delete src_file1 and chatDrop (with deleteSessions: true), and keep chatKeep (deleteSessions: false)
	const delFile = await sourcesRoute.DELETE(
		new Request("http://localhost/api/graph/sources", {
			method: "DELETE",
			body: JSON.stringify({ sourceIds: ["src_file1", chatDrop.id], folderIds: [], deleteSessions: true }),
		}),
	);
	assert.equal(delFile.status, 200);

	// Deleting chatKeep's contributions only (deleteSessions: false) must preserve its course membership
	const delContribOnly = await sourcesRoute.DELETE(
		new Request("http://localhost/api/graph/sources", {
			method: "DELETE",
			body: JSON.stringify({ sourceIds: [chatKeep.id], folderIds: [], deleteSessions: false }),
		}),
	);
	assert.equal(delContribOnly.status, 200);

	// Deleting via DELETE /api/chats/[id] must also drop course membership
	const delChatRoute = await chatByIdRoute.DELETE(
		new Request(`http://localhost/api/chats/${chatRouteDel.id}?mode=delete-nodes`, { method: "DELETE" }),
		{ params: Promise.resolve({ id: chatRouteDel.id }) },
	);
	assert.equal(delChatRoute.status, 200);

	const afterState = stores.courseStore.read();
	assert.equal(afterState.membership.src_file1, undefined);
	assert.equal(afterState.membership[chatDrop.id], undefined);
	assert.equal(afterState.membership[chatRouteDel.id], undefined);
	assert.equal(afterState.membership[chatKeep.id], cId);
	assert.equal(afterState.sessionFiles[chatDrop.id], undefined);
	assert.equal(afterState.sessionFiles[chatRouteDel.id], undefined);
	assert.deepEqual(afterState.sessionFiles[chatKeep.id], [fs.realpathSync.native(attachedSessionFile)]);
	assert.deepEqual(afterState.folderFiles["/tmp/file1.md"], {
		courseId: cId,
		folderId: "cfld_1",
		sourceId: "src_file1",
		sha256: "abc",
		extractedAt: "2026-11-20T00:00:00Z",
		excluded: true,
	});
});

it("malformed, oversized bodies return 400 and corrupt courses.json returns 500 without overwriting", async () => {
	await postCourse({ action: "create", name: "Safe" });
	const before = fs.readFileSync(COURSES_FILE, "utf8");
	for (const req of [
		new Request("http://localhost/api/courses", { method: "POST", body: "{" }),
		new Request("http://localhost/api/courses", { method: "POST", body: "x".repeat(65537) }),
	]) {
		assert.equal((await coursesRoute.POST(req)).status, 400);
	}
	assert.equal(fs.readFileSync(COURSES_FILE, "utf8"), before);

	try {
		for (const corrupt of ["{", '{"version":2,"courses":[],"membership":{},"folderFiles":{}}']) {
			fs.writeFileSync(COURSES_FILE, corrupt);
			assert.equal((await coursesRoute.GET()).status, 500);
			assert.equal((await postCourse({ action: "create", name: "Should not overwrite" })).status, 500);
			assert.equal(fs.readFileSync(COURSES_FILE, "utf8"), corrupt);
		}
	} finally {
		fs.writeFileSync(COURSES_FILE, before);
	}
});

it("attach-session-files validates course membership, regular files, ~ expansion, and sensitivity", async () => {
	const courseId = (await (await postCourse({ action: "create", name: "Systems" })).json()).courses[0].id as string;
	const courseChat = stores.chatStore.createChat("In course");
	const freeChat = stores.chatStore.createChat("No course");
	await postCourse({ action: "assign", sourceId: courseChat.id, courseId });

	const dir = path.join(root, "attach-dir");
	fs.mkdirSync(dir, { recursive: true });
	const okFile = path.join(dir, "lecture.md");
	fs.writeFileSync(okFile, "# Lecture");
	const envFile = path.join(dir, ".env");
	fs.writeFileSync(envFile, "SECRET=1");
	const symlinkToAuth = path.join(dir, "alias.txt");
	fs.symlinkSync(process.env.LH_AUTH_FILE!, symlinkToAuth);

	// Unknown chat and non-course chat -> 400
	assert.equal((await postCourse({ action: "attach-session-files", chatId: "chat_missing", paths: [okFile] })).status, 400);
	assert.equal((await postCourse({ action: "attach-session-files", chatId: freeChat.id, paths: [okFile] })).status, 400);

	// Empty paths, relative, missing, dir, sensitive (.env, auth file, symlink to auth) -> 400
	for (const badPaths of [
		[],
		["relative/lecture.md"],
		[path.join(dir, "missing.md")],
		[dir],
		[envFile],
		[process.env.LH_AUTH_FILE!],
		[symlinkToAuth],
	]) {
		assert.equal((await postCourse({ action: "attach-session-files", chatId: courseChat.id, paths: badPaths })).status, 400, JSON.stringify(badPaths));
	}

	// Unnormalized absolute path and ~ expansion normalize and store
	const homeDir = path.join(root, "fake-home");
	const homeFile = path.join(homeDir, "notes", "handout.txt");
	fs.mkdirSync(path.dirname(homeFile), { recursive: true });
	fs.writeFileSync(homeFile, "Handout");
	const prevHome = process.env.HOME;
	const prevProfile = process.env.USERPROFILE;
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	try {
		const res = await postCourse({
			action: "attach-session-files",
			chatId: courseChat.id,
			paths: [path.join(dir, "..", "attach-dir", "lecture.md"), "~/notes/handout.txt"],
		});
		assert.equal(res.status, 200);
		assert.deepEqual(stores.courseStore.read().sessionFiles[courseChat.id], [
			fs.realpathSync.native(okFile),
			fs.realpathSync.native(homeFile),
		]);
	} finally {
		if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
		if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
	}
});

it("POST /api/courses/files copies with clash suffixes, attaches managed folder once, scans, grants chatId, and rejects bad inputs", async () => {
	const courseId = (await (await postCourse({ action: "create", name: "ML" })).json()).courses[0].id as string;
	const otherCourseId = (await (await postCourse({ action: "create", name: "Other" })).json()).courses.find((c: { name: string }) => c.name === "Other").id as string;
	const chatMl = stores.chatStore.createChat("ML session");
	const chatOther = stores.chatStore.createChat("Other session");
	const chatFree = stores.chatStore.createChat("No course session");
	await postCourse({ action: "assign", sourceId: chatMl.id, courseId });
	await postCourse({ action: "assign", sourceId: chatOther.id, courseId: otherCourseId });

	const extracted: Array<{ sourceId: string; filePath: string; text: string }> = [];
	setCourseExtractorForTests(async (input) => {
		extracted.push(input);
		return { nodes: 1, chains: 0 };
	});

	const uploadFiles = (fields: { courseId?: string; chatId?: string; files: Array<{ name: string; body: Uint8Array<ArrayBuffer> | string }> }) => {
		const form = new FormData();
		if (fields.courseId !== undefined) form.append("courseId", fields.courseId);
		if (fields.chatId !== undefined) form.append("chatId", fields.chatId);
		for (const f of fields.files) form.append("files", new File([f.body], f.name));
		return courseFilesRoute.POST(new Request("http://localhost/api/courses/files", { method: "POST", body: form }));
	};

	// First upload creates managed folder, attaches it once with managed: true, copies files, grants chatId, starts scan
	const res1 = await uploadFiles({
		courseId,
		chatId: chatMl.id,
		files: [
			{ name: "week1.md", body: "# Week 1" },
			{ name: "week1.md", body: "# Week 1 duplicate" },
		],
	});
	assert.equal(res1.status, 200);
	const body1 = await res1.json();
	const expectedDir = path.join(COURSE_FILES_DIR, courseId);
	assert.deepEqual(body1.copied, [
		path.join(expectedDir, "week1.md"),
		path.join(expectedDir, "week1 (2).md"),
	]);
	const mlCourse1 = body1.courses.find((c: { id: string }) => c.id === courseId);
	assert.equal(mlCourse1.folders.length, 1);
	assert.equal(mlCourse1.folders[0].path, expectedDir);
	assert.equal(mlCourse1.folders[0].managed, true);
	assert.equal(mlCourse1.scanning, true);
	assert.equal(fs.readFileSync(path.join(expectedDir, "week1.md"), "utf8"), "# Week 1");
	assert.equal(fs.readFileSync(path.join(expectedDir, "week1 (2).md"), "utf8"), "# Week 1 duplicate");
	assert.deepEqual(stores.courseStore.read().sessionFiles[chatMl.id], body1.copied.map((p: string) => fs.realpathSync.native(p)));

	await waitForCourseScanForTests(courseId);
	assert.deepEqual(
		extracted.map((e) => e.filePath).sort(),
		[`${courseId}/week1 (2).md`, `${courseId}/week1.md`],
	);

	// Rejects chatId belonging to a different course, an unassigned chatId, or a missing chatId with 400 without writing files
	for (const badChatId of [chatOther.id, chatFree.id, "chat_missing"]) {
		const badChatRes = await uploadFiles({
			courseId,
			chatId: badChatId,
			files: [{ name: "rejected.md", body: "# Should not copy" }],
		});
		assert.equal(badChatRes.status, 400, `expected 400 for chatId ${badChatId}`);
		assert.equal(fs.existsSync(path.join(expectedDir, "rejected.md")), false);
		assert.equal(stores.courseStore.read().sessionFiles[badChatId], undefined);
	}

	// Second upload (no chatId) reuses existing managed folder (still 1 folder) and increments clash suffix
	const res2 = await uploadFiles({
		courseId,
		files: [{ name: "week1.md", body: "# Week 1 v3" }],
	});
	assert.equal(res2.status, 200);
	const body2 = await res2.json();
	assert.deepEqual(body2.copied, [path.join(expectedDir, "week1 (3).md")]);
	assert.equal(body2.courses.find((c: { id: string }) => c.id === courseId).folders.length, 1);
	await waitForCourseScanForTests(courseId);

	// Validation errors: missing/unknown courseId, no files, bad filenames, unsupported types, oversize
	assert.equal((await uploadFiles({ files: [{ name: "a.md", body: "hi" }] })).status, 400);
	assert.equal((await uploadFiles({ courseId: "crs_missing", files: [{ name: "a.md", body: "hi" }] })).status, 400);
	assert.equal((await uploadFiles({ courseId, files: [] })).status, 400);
	for (const badName of ["", ".", "..", "sub/a.md", "../a.md", "a\\b.md", "a\0b.md", ".env.md", ".hidden.md", "slides.pptx", "img.png"]) {
		const badRes = await uploadFiles({ courseId, files: [{ name: badName, body: "hi" }] });
		assert.equal(badRes.status, 400, `expected 400 for filename ${JSON.stringify(badName)}`);
	}

	// Single file > MAX_IMPORT_BYTES -> 413
	const hugeFileRes = await uploadFiles({
		courseId,
		files: [{ name: "huge.md", body: new Uint8Array(MAX_IMPORT_BYTES + 1) }],
	});
	assert.equal(hugeFileRes.status, 413);

	// Streamed body > MAX_IMPORT_BODY_BYTES -> 413
	let cancelled = false;
	const hugeStreamReq = new Request("http://localhost/api/courses/files", {
		method: "POST",
		duplex: "half",
		headers: { "content-type": "multipart/form-data; boundary=test", "content-length": "1" },
		body: new ReadableStream<Uint8Array>({
			pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
			cancel() { cancelled = true; },
		}, { highWaterMark: 0 }),
	} as RequestInit);
	const streamRes = await courseFilesRoute.POST(hugeStreamReq);
	assert.equal(streamRes.status, 413);
	assert.equal(cancelled, true);
	// No partial files left behind from failed uploads
	assert.deepEqual(fs.readdirSync(expectedDir).sort(), ["week1 (2).md", "week1 (3).md", "week1.md"]);
});

it("deleting a course-folder source excludes it across rescans until include-file re-extracts it", async () => {
	const folderDir = path.join(root, "excl-folder");
	fs.mkdirSync(folderDir, { recursive: true });
	const fileA = path.join(folderDir, "a.md");
	const fileB = path.join(folderDir, "b.md");
	fs.writeFileSync(fileA, "# A v1");
	fs.writeFileSync(fileB, "# B v1");

	const calls: string[] = [];
	setCourseExtractorForTests(async ({ sourceId, filePath }) => {
		calls.push(filePath);
		stores.graphStore.upsertSource({ id: sourceId, filePath, importedAt: "2026-11-20T00:00:00Z" });
		return { nodes: 1, chains: 0 };
	});

	const created = await (await postCourse({ action: "create", name: "Bio" })).json();
	const courseId = created.courses[0].id as string;
	await postCourse({ action: "add-folder", id: courseId, path: folderDir });
	await waitForCourseScanForTests(courseId);
	assert.equal(calls.length, 2);

	const srcA = courseFileSourceId(fileA);
	const prevSha = stores.courseStore.read().folderFiles[fileA]?.sha256;
	assert.ok(prevSha);

	// Delete srcA via source deletion -> membership removed, folderFiles marked excluded (sha256 kept)
	const delRes = await sourcesRoute.DELETE(
		new Request("http://localhost/api/graph/sources", {
			method: "DELETE",
			body: JSON.stringify({ sourceIds: [srcA], folderIds: [], deleteSessions: false }),
		}),
	);
	assert.equal(delRes.status, 200);

	const stateAfterDel = stores.courseStore.read();
	assert.equal(stateAfterDel.membership[srcA], undefined);
	assert.equal(stateAfterDel.folderFiles[fileA]?.excluded, true);
	assert.equal(stateAfterDel.folderFiles[fileA]?.sha256, prevSha);

	const viewAfterDel = await (await coursesRoute.GET()).json();
	const bioFilesAfterDel = viewAfterDel.courses.find((c: { id: string }) => c.id === courseId).files;
	assert.equal(bioFilesAfterDel.find((f: { path: string }) => f.path === fileA)?.state, "excluded");
	assert.equal(bioFilesAfterDel.find((f: { path: string }) => f.path === fileB)?.state, "extracted");

	// Modify fileA and rescan -> excluded file is skipped
	calls.length = 0;
	fs.writeFileSync(fileA, "# A v2 modified");
	await postCourse({ action: "rescan", id: courseId });
	await waitForCourseScanForTests(courseId);
	assert.deepEqual(calls, []);
	const viewAfterScan = await (await coursesRoute.GET()).json();
	assert.equal(viewAfterScan.courses[0].files.find((f: { path: string }) => f.path === fileA)?.state, "excluded");

	// include-file on non-excluded file -> 400
	assert.equal((await postCourse({ action: "include-file", id: courseId, path: fileB })).status, 400);

	// include-file on excluded file -> clears exclusion and starts scan -> re-extracts
	const incRes = await postCourse({ action: "include-file", id: courseId, path: fileA });
	assert.equal(incRes.status, 200);
	await waitForCourseScanForTests(courseId);
	assert.deepEqual(calls, ["excl-folder/a.md"]);
	const finalView = await (await coursesRoute.GET()).json();
	assert.equal(finalView.courses[0].files.find((f: { path: string }) => f.path === fileA)?.state, "extracted");
	assert.equal(finalView.membership[srcA], courseId);
	assert.equal(stores.courseStore.read().folderFiles[fileA]?.excluded, undefined);
});

it("course delete removes managed folder on delete-sources (with containment) and keeps it on ungroup", async () => {
	setCourseExtractorForTests(async ({ sourceId, filePath }) => {
		stores.graphStore.upsertSource({ id: sourceId, filePath, importedAt: "2026-11-20T00:00:00Z" });
		return { nodes: 1, chains: 0 };
	});

	const uploadOne = (courseId: string, name: string, body: string) => {
		const form = new FormData();
		form.append("courseId", courseId);
		form.append("files", new File([body], name));
		return courseFilesRoute.POST(new Request("http://localhost/api/courses/files", { method: "POST", body: form }));
	};

	// Course 1: ungroup keeps managed copies and chat sessionFiles on disk
	const c1 = (await (await postCourse({ action: "create", name: "KeepCopies" })).json()).courses[0].id as string;
	const chat1 = stores.chatStore.createChat("Kept session");
	await postCourse({ action: "assign", sourceId: chat1.id, courseId: c1 });
	const up1 = await (await uploadOne(c1, "kept.md", "# kept")).json();
	const copied1 = up1.copied[0] as string;
	await postCourse({ action: "attach-session-files", chatId: chat1.id, paths: [copied1] });
	await waitForCourseScanForTests(c1);

	const delUngroup = await postCourse({ action: "delete", id: c1, mode: "ungroup" });
	assert.equal(delUngroup.status, 200);
	assert.equal(fs.existsSync(copied1), true);
	assert.equal(stores.graphStore.readSources().some((s) => s.id === courseFileSourceId(copied1)), true);
	assert.deepEqual(stores.courseStore.read().sessionFiles[chat1.id], [fs.realpathSync.native(copied1)]);

	// Course 2: delete-sources removes managed folder inside COURSE_FILES_DIR, never user folders or outside paths
	const c2 = (await (await postCourse({ action: "create", name: "RemoveCopies" })).json()).courses[0].id as string;
	const extDir = path.join(root, "user-external");
	fs.mkdirSync(extDir, { recursive: true });
	const extFile = path.join(extDir, "orig.md");
	fs.writeFileSync(extFile, "# external");
	await postCourse({ action: "add-folder", id: c2, path: extDir });
	await waitForCourseScanForTests(c2);

	const up2 = await (await uploadOne(c2, "managed.md", "# managed")).json();
	const copied2 = up2.copied[0] as string;
	const managedDir2 = path.join(COURSE_FILES_DIR, c2);
	await waitForCourseScanForTests(c2);

	// Inject a rogue managed: true folder outside COURSE_FILES_DIR to test containment guard
	const outsideProtected = path.join(root, "outside-managed-guard");
	fs.mkdirSync(outsideProtected, { recursive: true });
	const outsideFile = path.join(outsideProtected, "keep.md");
	fs.writeFileSync(outsideFile, "do not delete");
	const tampered = stores.courseStore.read();
	tampered.courses.find((c) => c.id === c2)!.folders.push({
		id: "cfld_rogue",
		path: outsideProtected,
		addedAt: "2026-11-20T00:00:00Z",
		managed: true,
	});
	stores.courseStore.write(tampered);

	const delPurge = await postCourse({ action: "delete", id: c2, mode: "delete-sources" });
	assert.equal(delPurge.status, 200);
	assert.equal(fs.existsSync(managedDir2), false);
	assert.equal(fs.existsSync(extFile), true, "user-attached external folder must never be deleted");
	assert.equal(fs.existsSync(outsideFile), true, "containment guard must protect paths outside COURSE_FILES_DIR");
	assert.equal(stores.graphStore.readSources().some((s) => s.id === courseFileSourceId(copied2)), false);
});

it("POST /api/courses/files refuses a symlinked managed course folder and writes nothing through it", async () => {
	const courseId = (await (await postCourse({ action: "create", name: "LinkTrap" })).json()).courses.find((c: { name: string }) => c.name === "LinkTrap").id as string;
	const elsewhere = fs.mkdtempSync(path.join(root, "elsewhere-"));
	fs.mkdirSync(COURSE_FILES_DIR, { recursive: true });
	fs.symlinkSync(elsewhere, path.join(COURSE_FILES_DIR, courseId));
	const form = new FormData();
	form.append("courseId", courseId);
	form.append("files", new File(["# hi"], "notes.md"));
	const delRes = await courseFilesRoute.POST(new Request("http://localhost/api/courses/files", { method: "POST", body: form }));
	assert.equal(delRes.status, 400);
	assert.match((await delRes.json()).error, /managed file folder/);
	assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing written through the link");
});

it("delete-sources keeps managed copies owned by another course and removes own, unassigned, and unrecorded copies", async () => {
	setCourseExtractorForTests(async ({ sourceId, filePath }) => {
		stores.graphStore.upsertSource({ id: sourceId, filePath, importedAt: "2026-11-20T00:00:00Z" });
		return { nodes: 1, chains: 0 };
	});

	const cA = (await (await postCourse({ action: "create", name: "CourseA" })).json()).courses[0].id as string;
	const cB = (await (await postCourse({ action: "create", name: "CourseB" })).json()).courses.find((c: { name: string }) => c.name === "CourseB").id as string;

	const form = new FormData();
	form.append("courseId", cA);
	form.append("files", new File(["# own"], "own.md"));
	form.append("files", new File(["# movedB"], "moved-b.md"));
	form.append("files", new File(["# movedNone"], "moved-none.md"));
	const upRes = await courseFilesRoute.POST(new Request("http://localhost/api/courses/files", { method: "POST", body: form }));
	assert.equal(upRes.status, 200);
	const { copied } = (await upRes.json()) as { copied: string[] };
	const [ownPath, movedBPath, movedNonePath] = copied as [string, string, string];
	await waitForCourseScanForTests(cA);

	const managedDirA = path.join(COURSE_FILES_DIR, cA);
	const orphanPath = path.join(managedDirA, "orphan.md");
	fs.writeFileSync(orphanPath, "# no folderFiles record");

	const srcOwn = courseFileSourceId(ownPath);
	const srcMovedB = courseFileSourceId(movedBPath);
	const srcMovedNone = courseFileSourceId(movedNonePath);
	await postCourse({ action: "assign", sourceId: srcMovedB, courseId: cB });
	await postCourse({ action: "assign", sourceId: srcMovedNone, courseId: null });

	const delRes = await postCourse({ action: "delete", id: cA, mode: "delete-sources" });
	assert.equal(delRes.status, 200);

	assert.equal(fs.existsSync(ownPath), false, "A's own managed file is deleted");
	assert.equal(fs.existsSync(movedNonePath), false, "unassigned managed file is deleted");
	assert.equal(fs.existsSync(orphanPath), false, "unrecorded file in managed dir is deleted");
	assert.equal(fs.existsSync(movedBPath), true, "managed file moved to B must remain on disk");
	assert.equal(fs.existsSync(managedDirA), true, "managed dir remains while anything stays inside");
	assert.equal(stores.graphStore.readSources().some((s) => s.id === srcOwn), false);
	assert.equal(stores.graphStore.readSources().some((s) => s.id === srcMovedB), true);
	assert.equal(stores.courseStore.read().membership[srcMovedB], cB);
});

it("folder overlap compares canonical paths in both directions including aliases and managed folders", async () => {
	const c1 = (await (await postCourse({ action: "create", name: "CourseOne" })).json()).courses[0].id as string;
	const c2 = (await (await postCourse({ action: "create", name: "CourseTwo" })).json()).courses.find((c: { name: string }) => c.name === "CourseTwo").id as string;

	const realBase = path.join(root, "real-base");
	const nestedDir = path.join(realBase, "week1");
	fs.mkdirSync(nestedDir, { recursive: true });
	const aliasToBase = path.join(root, "alias-base");
	const aliasToNested = path.join(root, "alias-week1");
	fs.symlinkSync(realBase, aliasToBase, "dir");
	fs.symlinkSync(nestedDir, aliasToNested, "dir");

	// Attach realBase to CourseOne, then reject direct alias and nested alias on same/other course
	assert.equal((await postCourse({ action: "add-folder", id: c1, path: realBase })).status, 200);
	const sameAlias = await postCourse({ action: "add-folder", id: c1, path: aliasToBase });
	assert.equal(sameAlias.status, 400);
	assert.match((await sameAlias.json()).error, /overlaps/);

	const otherAlias = await postCourse({ action: "add-folder", id: c2, path: aliasToBase });
	assert.equal(otherAlias.status, 400);
	assert.match((await otherAlias.json()).error, /CourseOne/);

	const nestedAlias = await postCourse({ action: "add-folder", id: c2, path: aliasToNested });
	assert.equal(nestedAlias.status, 400);
	assert.match((await nestedAlias.json()).error, /CourseOne/);

	// Reverse direction: attach aliasToNested to CourseTwo (after removing realBase), then reject realBase on CourseOne
	await postCourse({ action: "delete", id: c1, mode: "ungroup" });
	const c1b = (await (await postCourse({ action: "create", name: "CourseOneB" })).json()).courses.find((c: { name: string }) => c.name === "CourseOneB").id as string;
	assert.equal((await postCourse({ action: "add-folder", id: c2, path: aliasToNested })).status, 200);
	const parentOfAlias = await postCourse({ action: "add-folder", id: c1b, path: realBase });
	assert.equal(parentOfAlias.status, 400);
	assert.match((await parentOfAlias.json()).error, /CourseTwo/);

	// Managed folder overlap: CourseTwo attaches an alias to LH_DATA_DIR (ancestor of COURSE_FILES_DIR) -> upload to CourseOneB returns 400
	await postCourse({ action: "delete", id: c2, mode: "ungroup" });
	const c2b = (await (await postCourse({ action: "create", name: "AncestorOwner" })).json()).courses.find((c: { name: string }) => c.name === "AncestorOwner").id as string;
	const dataAncestorAlias = path.join(os.tmpdir(), `lh-data-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.symlinkSync(root, dataAncestorAlias, "dir");
	try {
		assert.equal((await postCourse({ action: "add-folder", id: c2b, path: dataAncestorAlias })).status, 200);
		const form = new FormData();
		form.append("courseId", c1b);
		form.append("files", new File(["# hi"], "notes.md"));
		const uploadRes = await courseFilesRoute.POST(new Request("http://localhost/api/courses/files", { method: "POST", body: form }));
		assert.equal(uploadRes.status, 400);
		assert.match((await uploadRes.json()).error, /AncestorOwner/);
		assert.equal(fs.existsSync(path.join(COURSE_FILES_DIR, c1b)), false, "managed folder must not be created on overlap refusal");
	} finally {
		fs.rmSync(dataAncestorAlias, { recursive: true, force: true });
	}
});
