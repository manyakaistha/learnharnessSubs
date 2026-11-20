import React, { act, type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import {
	COURSE_ATTACH_MODE_STORAGE_PREFIX,
	COURSE_FILTER_STORAGE_KEY,
	CoursesProvider,
	useCourseAttachTarget,
} from "../components/courses.tsx";
import { Composer } from "../components/composer.tsx";
import { FilePathDropZone } from "../components/file-path-drop-zone.tsx";
import { Home } from "../components/home.tsx";
import { NewSession } from "../components/new-session.tsx";
import { NotesImportControl, NotesImportErrors, NotesImportNotices, useNotesImport } from "../components/notes-import.tsx";
import { CoursePanelBody, CoursePanelDialog } from "../components/course-dialog.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { HostContentRootContext, HostRouteLifetimeProvider } from "../components/host-content-root.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { restorePathSelection } from "../components/path-input-dom.ts";
import { installModalDom } from "./modal-dom.ts";
import type { CourseFilesResponse, CourseRequest, CourseView, CoursesView } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
const selectionStub = {
	anchorNode: null as Node | null,
	anchorOffset: 0,
	focusNode: null as Node | null,
	focusOffset: 0,
	setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
		Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
	},
};
Object.assign(dom.document, { getSelection: () => selectionStub, oninput: null, onchange: null });

function makeStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => { map.set(k, String(v)); },
		removeItem: (k: string) => { map.delete(k); },
		clear: () => { map.clear(); },
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() { return map.size; },
	};
}

const localStorageStub = makeStorage();
const sessionStorageStub = makeStorage();
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const testGlobals: Record<string, unknown> = {
	window: dom.window,
	self: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	SVGElement: dom.window.SVGElement,
	Event: dom.window.Event,
	MouseEvent: dom.window.MouseEvent,
	CustomEvent: dom.window.CustomEvent,
	navigator: { maxTouchPoints: 0, userAgent: "fixture" },
	localStorage: localStorageStub,
	sessionStorage: sessionStorageStub,
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	Path2D: class { moveTo() {} lineTo() {} arc() {} closePath() {} },
	IS_REACT_ACT_ENVIRONMENT: true,
	innerWidth: 1000,
	innerHeight: 800,
};
for (const [k, v] of Object.entries(testGlobals)) {
	previousGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
	Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
}
Object.assign(dom.window, { localStorage: localStorageStub, sessionStorage: sessionStorageStub, innerWidth: 1000, innerHeight: 800 });
const restoreModalDom = installModalDom(dom);
const baseStyle = globalThis.getComputedStyle;
const fullStyle = (el: HTMLElement) => ({
	...baseStyle(el),
	fontFamily: "fixture-sans",
	getPropertyValue: (name: string) => el.style?.getPropertyValue?.(name) ?? "",
});
Object.assign(globalThis, { getComputedStyle: fullStyle });
Object.assign(dom.window, { getComputedStyle: fullStyle });
const { createRoot } = await import("react-dom/client");
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
	return { top: 540, bottom: 580, left: 200, right: 240, width: 40, height: 40, x: 200, y: 540, toJSON() {} };
};
const originalFetch = globalThis.fetch;

after(() => {
	restoreModalDom();
	for (const [k, desc] of previousGlobals) {
		if (desc) Object.defineProperty(globalThis, k, desc);
		else Reflect.deleteProperty(globalThis, k);
	}
	globalThis.fetch = originalFetch;
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const pushedRoutes: string[] = [];

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	await new Promise((r) => setTimeout(r, 5));
	host?.remove();
	host = undefined;
	delete (dom.window as unknown as Record<string, unknown>).lh;
	localStorageStub.clear();
	sessionStorageStub.clear();
	pushedRoutes.length = 0;
	globalThis.fetch = originalFetch;
});

function makeCourse(id: string, name: string, overrides: Partial<CourseView> = {}): CourseView {
	return {
		id,
		name,
		createdAt: "2026-11-20T00:00:00.000Z",
		includes: [],
		folders: [],
		ownSourceIds: [],
		includedCourseIds: [],
		files: [],
		scanning: false,
		...overrides,
	};
}

async function mountWithProviders(
	node: ReactNode,
	options: { pathname?: string; withShellContexts?: boolean } = {},
) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const pathname = options.pathname ?? "/";
	const router = {
		bfcacheId: "fixture",
		back() {},
		forward() {},
		refresh() {},
		hmrRefresh() {},
		push(href: string) { pushedRoutes.push(href); },
		replace(href: string) { pushedRoutes.push(href); },
		async prefetch() {},
	};
	const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	const inner = options.withShellContexts
		? (
			<HostRouteLifetimeProvider pathname={pathname}>
				<HostContentRootContext.Provider value={host}>
					<InteractionLayersProvider>
						<SettingsDialogProvider>
							<CoursesProvider>
								<SidebarProvider>
									<ActivityProvider>{node}</ActivityProvider>
								</SidebarProvider>
							</CoursesProvider>
						</SettingsDialogProvider>
					</InteractionLayersProvider>
				</HostContentRootContext.Provider>
			</HostRouteLifetimeProvider>
		)
		: (
			<InteractionLayersProvider>
				<CoursesProvider>{node}</CoursesProvider>
			</InteractionLayersProvider>
		);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<PathnameContext.Provider value={pathname}>
					<ServerEventsProvider connect={connect}>{inner}</ServerEventsProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
}

function setDesktopBridge(backingPaths: Map<File, string>) {
	Object.defineProperty(dom.window, "lh", {
		configurable: true,
		value: {
			getPathForFile: (file: File) => backingPaths.get(file) ?? "",
			chooseAttachmentFolder: async () => null,
		},
	});
}

async function pickInputFiles(files: File[]) {
	const picker = document.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
	assert.ok(picker);
	Object.defineProperty(picker, "files", { configurable: true, value: files });
	await act(async () => {
		picker.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	});
}

async function clickTestId(id: string) {
	const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert.ok(el, `missing [data-testid="${id}"]`);
	await act(async () => { el.click(); });
}

describe("Paperclip attach mode toggle and flows", () => {
	it("hides the toggle when no course is active, shows it when a course is active, and remembers choice per course", async () => {
		const backing = new Map<File, string>();
		setDesktopBridge(backing);
		const view: CoursesView = {
			courses: [makeCourse("crs_1", "Vision"), makeCourse("crs_2", "Physics")],
			membership: {},
		};
		globalThis.fetch = async (url) => {
			if (url === "/api/courses") return Response.json(view);
			return Response.json({});
		};

		// No course active -> toggle hidden
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "all");
		let value = "";
		await mountWithProviders(
			<div data-attachment-composer="">
				<Composer busy={false} value={value} onChange={(v) => { value = v; }} onSend={() => {}} onStop={() => {}} canSend={false} chatId="chat_1" />
			</div>,
		);
		await clickTestId("attach-files");
		assert.equal(document.querySelector('[data-testid="attach-mode-toggle"]'), null);
		assert.equal(document.querySelectorAll('[role="menuitem"]').length, 2);

		// Course 1 active -> defaults to "This session only", remembers switch to "Add to course sources"
		await act(async () => { root!.unmount(); });
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_1");
		await mountWithProviders(
			<div data-attachment-composer="">
				<Composer busy={false} value={value} onChange={(v) => { value = v; }} onSend={() => {}} onStop={() => {}} canSend={false} chatId="chat_1" />
			</div>,
		);
		await clickTestId("attach-files");
		const toggle = document.querySelector('[data-testid="attach-mode-toggle"]');
		assert.ok(toggle);
		const sessionBtn = document.querySelector<HTMLButtonElement>('[data-testid="attach-mode-session"]')!;
		const courseBtn = document.querySelector<HTMLButtonElement>('[data-testid="attach-mode-course"]')!;
		assert.equal(sessionBtn.textContent, "This session only");
		assert.equal(courseBtn.textContent, "Add to course sources");
		assert.equal(sessionBtn.getAttribute("aria-checked"), "true");
		assert.equal(courseBtn.getAttribute("aria-checked"), "false");

		await clickTestId("attach-mode-course");
		assert.equal(courseBtn.getAttribute("aria-checked"), "true");
		assert.equal(localStorageStub.getItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`), "course");

		// Course 2 active -> independent default "This session only"
		await act(async () => { root!.unmount(); });
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_2");
		await mountWithProviders(
			<div data-attachment-composer="">
				<Composer busy={false} value={value} onChange={(v) => { value = v; }} onSend={() => {}} onStop={() => {}} canSend={false} chatId="chat_2" />
			</div>,
		);
		await clickTestId("attach-files");
		assert.equal(document.querySelector('[data-testid="attach-mode-session"]')!.getAttribute("aria-checked"), "true");
		assert.equal(localStorageStub.getItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`), "course");
	});

	it("This session only on existing chat inserts path chips, posts attach-session-files, and shows server errors inline", async () => {
		const backing = new Map<File, string>();
		setDesktopBridge(backing);
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_1");
		const posts: CourseRequest[] = [];
		let failNext = false;
		const view: CoursesView = { courses: [makeCourse("crs_1", "Vision")], membership: { chat_1: "crs_1" } };
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				posts.push(body);
				if (failNext) return Response.json({ error: "Chat does not belong to this course." }, { status: 400 });
				return Response.json(view);
			}
			if (url === "/api/courses") return Response.json(view);
			return Response.json({});
		};

		let value = "";
		function Harness() {
			const [v, setV] = React.useState("");
			value = v;
			return (
				<div data-attachment-composer="">
					<Composer busy={false} value={v} onChange={setV} onSend={() => {}} onStop={() => {}} canSend chatId="chat_1" />
				</div>
			);
		}
		await mountWithProviders(<Harness />);
		const f1 = new File(["pdf"], "lecture1.pdf");
		backing.set(f1, "/notes/lecture1.pdf");
		await pickInputFiles([f1]);
		assert.equal(value, "`/notes/lecture1.pdf`");
		assert.deepEqual(posts.at(-1), { action: "attach-session-files", chatId: "chat_1", paths: ["/notes/lecture1.pdf"] });

		failNext = true;
		const f2 = new File(["pdf"], "lecture2.pdf");
		backing.set(f2, "/notes/lecture2.pdf");
		await pickInputFiles([f2]);
		const err = document.querySelector('[data-testid="attachment-error"]');
		assert.ok(err);
		assert.match(err.textContent!, /Chat does not belong to this course/);
	});

	it("Add to course sources on existing chat uploads multipart FormData with courseId + chatId, shows progress/errors, and inserts copied paths", async () => {
		const backing = new Map<File, string>();
		setDesktopBridge(backing);
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_1");
		localStorageStub.setItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`, "course");
		const view: CoursesView = { courses: [makeCourse("crs_1", "Vision")], membership: { chat_1: "crs_1" } };

		let resolveUpload!: (res: Response) => void;
		let uploadedForm: FormData | undefined;
		let shouldFail = false;
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses") return Response.json(view);
			if (url === "/api/courses/files" && init?.method === "POST") {
				uploadedForm = init.body as FormData;
				if (shouldFail) return Response.json({ error: "Unsupported file type." }, { status: 400 });
				return new Promise<Response>((resolve) => { resolveUpload = resolve; });
			}
			return Response.json({});
		};

		let value = "";
		function Harness() {
			const [v, setV] = React.useState("");
			value = v;
			return (
				<div data-attachment-composer="">
					<Composer busy={false} value={v} onChange={setV} onSend={() => {}} onStop={() => {}} canSend chatId="chat_1" />
				</div>
			);
		}
		await mountWithProviders(<Harness />);

		const f = new File(["hello"], "slides.pdf", { type: "application/pdf" });
		backing.set(f, "/Users/me/Downloads/slides.pdf");
		await pickInputFiles([f]);
		assert.match(document.querySelector('[data-testid="attachment-popup"]')!.textContent!, /Adding to course sources/);
		assert.ok(uploadedForm);
		const form = uploadedForm as FormData;
		assert.equal(form.get("courseId"), "crs_1");
		assert.equal(form.get("chatId"), "chat_1");
		assert.equal((form.getAll("files") as File[])[0]!.name, "slides.pdf");

		const responsePayload: CourseFilesResponse = {
			...view,
			copied: ["/data/course-files/crs_1/slides.pdf"],
		};
		await act(async () => {
			resolveUpload(Response.json(responsePayload));
		});
		assert.equal(value, "`/data/course-files/crs_1/slides.pdf`");
		assert.equal(document.querySelector('[data-testid="attachment-popup"]'), null);

		shouldFail = true;
		await pickInputFiles([new File(["bad"], "bad.exe")]);
		const err = document.querySelector('[data-testid="attachment-error"]');
		assert.ok(err);
		assert.match(err.textContent!, /Unsupported file type/);
	});

	it("Draft flow (Home and NewSession) remembers session-only and copied paths and posts attach-session-files after chat creation", async () => {
		const backing = new Map<File, string>();
		setDesktopBridge(backing);
		const slot = { model: { provider: "p", id: "m1" }, thinkingLevel: "off" };
		const view: CoursesView = { courses: [makeCourse("crs_1", "Vision")], membership: {} };
		const coursePosts: CourseRequest[] = [];
		const fileUploads: Array<{ courseId: unknown; chatId: unknown; names: string[] }> = [];
		let chatCounter = 0;

		globalThis.fetch = async (url, init) => {
			const u = String(url);
			if (u === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				coursePosts.push(body);
				return Response.json(view);
			}
			if (u === "/api/courses") return Response.json(view);
			if (u === "/api/courses/files" && init?.method === "POST") {
				const form = init.body as FormData;
				fileUploads.push({
					courseId: form.get("courseId"),
					chatId: form.get("chatId"),
					names: (form.getAll("files") as File[]).map((f) => f.name),
				});
				return Response.json({ ...view, copied: ["/data/course-files/crs_1/copied.pdf"] } satisfies CourseFilesResponse);
			}
			if (u === "/api/models") {
				return Response.json({
					models: [{ id: "m1", provider: "p", name: "m1", input: ["text"], reasoning: false, supportedLevels: ["off"], maxTokens: 1000, contextWindow: 8000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
					providers: [{ id: "p", name: "P", keyPresent: true }],
					defaults: null,
					slots: { strong: slot, cheap: slot, vision: slot },
					rolePins: {},
				});
			}
			if (u === "/api/graph/costs") return Response.json({ stages: { extraction: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} }, audit: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} } }, runs: [] });
			if (u.startsWith("/api/graph")) return Response.json({ nodes: [], propositions: [], edges: [], logicalEdges: [], impLinks: [], chains: [], sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [] });
			if (u === "/api/chats" && init?.method === "POST") {
				chatCounter++;
				return Response.json({ id: `chat_draft_${chatCounter}` });
			}
			if (u === "/api/chats") return Response.json({ chats: [] });
			if (u === "/api/plugins") return Response.json({ plugins: [], directory: "/tmp" });
			if (u === "/api/settings") return Response.json({ settings: { models: {} } });
			return Response.json({});
		};

		// 1) Home draft in "This session only"
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_1");
		localStorageStub.setItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`, "session");
		await mountWithProviders(<Home initialConfigured rendering={false} />, { withShellContexts: true });
		const f1 = new File(["a"], "handout.pdf");
		backing.set(f1, "/notes/handout.pdf");
		await pickInputFiles([f1]);
		const textbox = document.querySelector<HTMLElement>('[role="textbox"]')!;
		await act(async () => {
			textbox.textContent = "Explain handout";
			textbox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		await act(async () => {
			textbox.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(coursePosts.at(-1), {
			action: "attach-session-files",
			chatId: "chat_draft_1",
			paths: ["/notes/handout.pdf"],
		});
		assert.equal(pushedRoutes[0], "/chat/chat_draft_1");

		// 2) NewSession draft in "Add to course sources" (uploads without chatId, then attaches copied path after chat creation)
		await act(async () => { root!.unmount(); });
		localStorageStub.setItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`, "course");
		await mountWithProviders(<NewSession initialConfigured />, { pathname: "/chat/new", withShellContexts: true });
		const f2 = new File(["b"], "copied.pdf");
		backing.set(f2, "/orig/copied.pdf");
		await pickInputFiles([f2]);
		assert.deepEqual(fileUploads[0], { courseId: "crs_1", chatId: null, names: ["copied.pdf"] });
		const draftBox = document.querySelector<HTMLElement>('[role="textbox"]')!;
		await act(async () => {
			draftBox.textContent = "Review copied";
			draftBox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		await act(async () => {
			draftBox.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(coursePosts.at(-1), {
			action: "attach-session-files",
			chatId: "chat_draft_2",
			paths: ["/data/course-files/crs_1/copied.pdf"],
		});
		assert.equal(pushedRoutes[1], "/chat/chat_draft_2");

		// 3) Draft attach-session-files failure shows inline error and stays on draft
		await act(async () => { root!.unmount(); });
		localStorageStub.setItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`, "session");
		globalThis.fetch = async (url, init) => {
			const u = String(url);
			if (u === "/api/courses" && init?.method === "POST") {
				return Response.json({ error: "Attached file does not exist." }, { status: 400 });
			}
			if (u === "/api/courses") return Response.json(view);
			if (u === "/api/models") {
				return Response.json({
					models: [{ id: "m1", provider: "p", name: "m1", input: ["text"], reasoning: false, supportedLevels: ["off"], maxTokens: 1000, contextWindow: 8000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
					providers: [{ id: "p", name: "P", keyPresent: true }],
					defaults: null,
					slots: { strong: slot, cheap: slot, vision: slot },
					rolePins: {},
				});
			}
			if (u === "/api/graph/costs") return Response.json({ stages: { extraction: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} }, audit: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} } }, runs: [] });
			if (u.startsWith("/api/graph")) return Response.json({ nodes: [], propositions: [], edges: [], logicalEdges: [], impLinks: [], chains: [], sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [] });
			if (u === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_draft_fail" });
			if (u === "/api/chats") return Response.json({ chats: [] });
			if (u === "/api/plugins") return Response.json({ plugins: [], directory: "/tmp" });
			if (u === "/api/settings") return Response.json({ settings: { models: {} } });
			return Response.json({});
		};
		await mountWithProviders(<NewSession initialConfigured />, { pathname: "/chat/new", withShellContexts: true });
		const f3 = new File(["c"], "missing.pdf");
		backing.set(f3, "/notes/missing.pdf");
		await pickInputFiles([f3]);
		const failBox = document.querySelector<HTMLElement>('[role="textbox"]')!;
		await act(async () => {
			failBox.textContent = "Try missing file";
			failBox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		await act(async () => {
			failBox.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.equal(pushedRoutes.length, 2, "does not navigate when attach-session-files fails");
		assert.match(document.querySelector('[data-testid="draft-attach-error"]')!.textContent!, /Attached file does not exist/);
	});

	it("Drag-and-drop follows remembered per-course mode for both session-only and add-to-course-sources", async () => {
		const backing = new Map<File, string>();
		setDesktopBridge(backing);
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_1");
		const view: CoursesView = { courses: [makeCourse("crs_1", "Vision")], membership: { chat_9: "crs_1" } };
		const posts: CourseRequest[] = [];
		const uploads: FormData[] = [];
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)) as CourseRequest);
				return Response.json(view);
			}
			if (url === "/api/courses") return Response.json(view);
			if (url === "/api/courses/files" && init?.method === "POST") {
				uploads.push(init.body as FormData);
				return Response.json({ ...view, copied: ["/data/course-files/crs_1/dropped.pdf"] } satisfies CourseFilesResponse);
			}
			return Response.json({});
		};

		let latestValue = "";
		function ChatHarness() {
			useCourseAttachTarget({ kind: "chat", chatId: "chat_9" });
			const [val, setVal] = React.useState("");
			latestValue = val;
			return (
				<FilePathDropZone>
					<div data-attachment-composer="">
						<Composer busy={false} value={val} onChange={setVal} onSend={() => {}} onStop={() => {}} canSend chatId="chat_9" />
					</div>
					<div data-testid="drop-target">Drop here</div>
				</FilePathDropZone>
			);
		}
		await mountWithProviders(<ChatHarness />);
		const editor = document.querySelector<HTMLElement>("[data-file-path-input]")!;
		editor.focus();
		restorePathSelection(editor, { anchor: 0, focus: 0 });
		document.dispatchEvent(new dom.window.Event("selectionchange"));

		const dropOn = async (files: File[]) => {
			const dataTransfer = {
				types: ["Files"],
				files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
				items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) })),
				dropEffect: "none",
			};
			const evt = Object.assign(new dom.window.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer });
			await act(async () => {
				document.querySelector('[data-testid="drop-target"]')!.dispatchEvent(evt);
			});
		};

		// Mode = session (default)
		const d1 = new File(["one"], "d1.pdf");
		backing.set(d1, "/local/d1.pdf");
		await dropOn([d1]);
		assert.equal(document.querySelector('[role="status"], [role="alert"]')?.textContent ?? "", "");
		assert.equal(latestValue, "`/local/d1.pdf`");
		assert.deepEqual(posts.at(-1), { action: "attach-session-files", chatId: "chat_9", paths: ["/local/d1.pdf"] });

		// Switch remembered mode to "course" -> drop uploads to /api/courses/files and inserts copied path
		localStorageStub.setItem(`${COURSE_ATTACH_MODE_STORAGE_PREFIX}crs_1`, "course");
		const d2 = new File(["two"], "dropped.pdf");
		backing.set(d2, "/local/dropped.pdf");
		await dropOn([d2]);
		assert.equal(uploads.length, 1);
		assert.equal(uploads[0]!.get("courseId"), "crs_1");
		assert.equal(uploads[0]!.get("chatId"), "chat_9");
		assert.match(latestValue, /\/data\/course-files\/crs_1\/dropped\.pdf/);
	});
});

describe("Extract files… course picker", () => {
	it("defaults to active course (or No course when All/None) and routes to /api/graph/import or /api/courses/files", async () => {
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_cv");
		const view: CoursesView = {
			courses: [makeCourse("crs_cv", "Computer Vision"), makeCourse("crs_dl", "Deep Learning")],
			membership: {},
		};
		const calls: Array<{ url: string; courseId: unknown; chatId: unknown }> = [];
		globalThis.fetch = async (url, init) => {
			const u = String(url);
			if (u === "/api/courses") return Response.json(view);
			if (u === "/api/graph/import" && init?.method === "POST") {
				const form = init.body as FormData;
				calls.push({ url: u, courseId: form.get("courseId"), chatId: form.get("chatId") });
				return Response.json({ results: [{ requestIndex: 0, filePath: "free.md", ok: true, outcome: "completed", stats: { nodes: 1, chains: 0 } }] });
			}
			if (u === "/api/courses/files" && init?.method === "POST") {
				const form = init.body as FormData;
				calls.push({ url: u, courseId: form.get("courseId"), chatId: form.get("chatId") });
				return Response.json({ ...view, copied: ["/data/course-files/crs_cv/notes.md"] } satisfies CourseFilesResponse);
			}
			return Response.json({});
		};

		function Harness() {
			const { importing, onImportFiles, errors, notices } = useNotesImport();
			return (
				<div>
					<NotesImportControl importing={importing} onImportFiles={onImportFiles} />
					<NotesImportErrors errors={errors} />
					<NotesImportNotices notices={notices} />
				</div>
			);
		}
		await mountWithProviders(<Harness />);

		await clickTestId("import-notes");
		const select = document.querySelector<HTMLSelectElement>('[data-testid="extract-course-select"]')!;
		assert.ok(select);
		assert.deepEqual([...select.options].map((o) => o.textContent), ["No course", "Computer Vision", "Deep Learning"]);
		assert.equal(select.value, "crs_cv", "defaults to active course");

		const filesInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[0]!;
		const f1 = new File(["cv"], "notes.md");
		Object.defineProperty(filesInput, "files", { configurable: true, value: [f1] });
		await act(async () => { filesInput.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
		assert.deepEqual(calls[0], { url: "/api/courses/files", courseId: "crs_cv", chatId: null });
		assert.match(document.body.textContent!, /notes\.md: Added to Computer Vision, extracting in the background\./);

		// Switch picker to No course -> uses /api/graph/import
		await act(async () => {
			for (const opt of select.options) opt.selected = opt.value === "";
			select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		const f2 = new File(["free"], "free.md");
		Object.defineProperty(filesInput, "files", { configurable: true, value: [f2] });
		await act(async () => { filesInput.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
		assert.deepEqual(calls[1], { url: "/api/graph/import", courseId: null, chatId: null });

		// When All is active, picker defaults to No course ("")
		await act(async () => { root!.unmount(); });
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "all");
		await mountWithProviders(<Harness />);
		await clickTestId("import-notes");
		assert.equal(document.querySelector<HTMLSelectElement>('[data-testid="extract-course-select"]')!.value, "");
	});
});

describe("CoursePanelBody & CoursePanelDialog managed folder and excluded files", () => {
	it("renders managed folder as 'Course files (copied)' with clear remove label, and excluded files with Include again", async () => {
		const staticHtml = renderToStaticMarkup(
			<CoursePanelBody
				course={makeCourse("crs_1", "Vision", {
					folders: [
						{ id: "cfld_managed", path: "/data/course-files/crs_1", addedAt: "2026-11-20", managed: true },
						{ id: "cfld_user", path: "/Users/me/cv", addedAt: "2026-11-20" },
					],
					files: [
						{ path: "/data/course-files/crs_1/w1.pdf", folderId: "cfld_managed", state: "excluded" },
						{ path: "/Users/me/cv/w2.md", folderId: "cfld_user", state: "extracted" },
					],
				})}
				allCourses={[]}
				renameDraft="Vision"
				onRenameDraft={() => {}}
				renameError=""
				renameBusy={false}
				onRenameSubmit={() => {}}
				includesError=""
				includesBusy={false}
				onToggleInclude={() => {}}
				folderInput=""
				onFolderInput={() => {}}
				folderError=""
				folderBusy={false}
				onAddFolder={() => {}}
				onRemoveFolder={() => {}}
				onIncludeFile={() => {}}
				rescanBusy={false}
				rescanError=""
				onRescan={() => {}}
				onOpenDelete={() => {}}
				onClose={() => {}}
			/>,
		);
		assert.match(staticHtml, /Course files \(copied\)/);
		assert.doesNotMatch(staticHtml, /\/data\/course-files\/crs_1<\/span>/);
		assert.match(staticHtml, /Remove from course/);
		assert.match(staticHtml, /Excluded/);
		assert.match(staticHtml, /Include again/);

		const posts: CourseRequest[] = [];
		let view: CoursesView = {
			courses: [makeCourse("crs_1", "Vision", {
				folders: [{ id: "cfld_managed", path: "/data/course-files/crs_1", addedAt: "2026-11-20", managed: true }],
				files: [{ path: "/data/course-files/crs_1/w1.pdf", folderId: "cfld_managed", state: "excluded" }],
			})],
			membership: {},
		};
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				posts.push(body);
				if (body.action === "include-file") {
					view = {
						...view,
						courses: view.courses.map((c) => c.id === body.id ? {
							...c,
							files: [{ path: body.path, folderId: "cfld_managed", state: "queued" }],
						} : c),
					};
				}
				return Response.json(view);
			}
			if (url === "/api/courses") return Response.json(view);
			return Response.json({});
		};

		await mountWithProviders(<CoursePanelDialog courseId="crs_1" open onClose={() => {}} />);
		assert.equal(document.querySelector('[data-testid="course-file-state"]')!.textContent, "Excluded");
		await clickTestId("course-file-include");
		assert.deepEqual(posts, [{ action: "include-file", id: "crs_1", path: "/data/course-files/crs_1/w1.pdf" }]);
		assert.equal(document.querySelector('[data-testid="course-file-state"]')!.textContent, "Queued");
		assert.equal(document.querySelector('[data-testid="course-file-include"]'), null);
	});
});
