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
const chatsRoute = await import("../app/api/chats/route.ts");
const chatByIdRoute = await import("../app/api/chats/[id]/route.ts");
const graphRoute = await import("../app/api/graph/route.ts");
const sourcesRoute = await import("../app/api/graph/sources/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { COURSES_FILE } = await import("../config.ts");

beforeEach(() => {
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

it("source deletion removes membership and folderFiles entries from courses.json", async () => {
	const cId = (await (await postCourse({ action: "create", name: "Physics" })).json()).courses[0].id as string;
	const chatKeep = stores.chatStore.createChat("Keep chat");
	const chatDrop = stores.chatStore.createChat("Drop chat");
	const chatRouteDel = stores.chatStore.createChat("Route deleted chat");
	stores.graphStore.upsertSource({ id: "src_file1", filePath: "/tmp/file1.md", importedAt: "2026-11-20T00:00:00Z" });

	for (const id of [chatKeep.id, chatDrop.id, chatRouteDel.id, "src_file1"]) {
		await postCourse({ action: "assign", sourceId: id, courseId: cId });
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
	assert.deepEqual(afterState.folderFiles, {});
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
