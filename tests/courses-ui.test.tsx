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
	COURSE_FILTER_STORAGE_KEY,
	CoursesProvider,
	activeCourseIdOf,
	chatMatchesCourseFilter,
	courseQueryParam,
	effectiveChatCourseId,
	parseStoredCourseFilter,
	reconcileCourseFilter,
	serializeCourseFilter,
	useCourses,
} from "../components/courses.tsx";
import { CourseSwitcher } from "../components/course-switcher.tsx";
import { CoursePanelDialog, DeleteCourseBody, DeleteCourseDialog } from "../components/course-dialog.tsx";
import { SessionsSidebar, SidebarProvider } from "../components/sidebar.tsx";
import { Home } from "../components/home.tsx";
import { MinimalHome } from "../components/minimal-home.tsx";
import { GraphView, NodeCardCourses, resolveNodeCourseNames, toCanvasNode } from "../components/graph-view.tsx";
import { GraphCanvasRenderer, INHERITED_NODE_ALPHA, type CanvasData } from "../components/graph-canvas.ts";
import { ChainTableOverlay, scopeSourceDirectoryFolders } from "../components/chain-table.tsx";
import { startDraftSession } from "../components/new-session.tsx";
import { SessionStarter } from "../components/start-session.ts";
import { PluginKnowledgePicker } from "../components/plugin-knowledge-picker.tsx";
import { HostContentRootContext, HostRouteLifetimeProvider } from "../components/host-content-root.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { ServerEventsProvider, createNotifyHub, type NotifySource } from "../components/server-events.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { ChatListItem, CourseRequest, CourseView, CoursesView, GraphSnapshot, SourceDirectory } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");

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
};
for (const [k, v] of Object.entries(testGlobals)) {
	previousGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
	Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
}
Object.assign(dom.window, { localStorage: localStorageStub, sessionStorage: sessionStorageStub });
Object.assign(dom.document, { oninput: null, onchange: null });
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
const nativeInputClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function () {
	if (this.type === "checkbox" || this.type === "radio") {
		if (this.type === "checkbox") this.checked = !this.checked;
		else this.checked = true;
	}
	nativeInputClick.call(this);
};
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
	return { top: 40, bottom: 72, left: 16, right: 220, width: 204, height: 32, x: 16, y: 40, toJSON() {} };
};
const originalFetch = globalThis.fetch;

after(() => {
	dom.window.HTMLInputElement.prototype.click = nativeInputClick;
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

function makeChat(id: string, title: string, courseId: string | null = null, overrides: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id,
		title,
		createdAt: "2026-11-20T00:00:00.000Z",
		updatedAt: "2026-11-20T01:00:00.000Z",
		kind: "teach",
		messageCount: 2,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		courseId,
		...overrides,
	};
}

async function mountWithProviders(
	node: ReactNode,
	options: { pathname?: string; connect?: () => NotifySource; withShellContexts?: boolean } = {},
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
	const connect = options.connect ?? (() => ({ close() {}, onOpen() {}, onEvent() {} }));
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

async function clickTestId(id: string) {
	const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert.ok(el, `missing [data-testid="${id}"]`);
	await act(async () => { el.click(); });
}

function setInputValue(el: HTMLInputElement, value: string) {
	el.focus();
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
	if (setter) setter.call(el, value);
	else el.value = value;
	el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

describe("courses pure helpers", () => {
	it("parses, serializes, reconciles, and formats course query/id helpers", () => {
		assert.deepEqual(parseStoredCourseFilter(null), { kind: "all" });
		assert.deepEqual(parseStoredCourseFilter("all"), { kind: "all" });
		assert.deepEqual(parseStoredCourseFilter("none"), { kind: "none" });
		assert.deepEqual(parseStoredCourseFilter("course:crs_1"), { kind: "course", courseId: "crs_1" });
		assert.deepEqual(parseStoredCourseFilter("course:"), { kind: "all" });

		assert.equal(serializeCourseFilter({ kind: "all" }), "all");
		assert.equal(serializeCourseFilter({ kind: "none" }), "none");
		assert.equal(serializeCourseFilter({ kind: "course", courseId: "crs_1" }), "course:crs_1");

		assert.equal(courseQueryParam({ kind: "all" }), "");
		assert.equal(courseQueryParam({ kind: "none" }), "?course=none");
		assert.equal(courseQueryParam({ kind: "course", courseId: "crs_a b" }), "?course=crs_a%20b");

		assert.equal(activeCourseIdOf({ kind: "all" }), null);
		assert.equal(activeCourseIdOf({ kind: "none" }), null);
		assert.equal(activeCourseIdOf({ kind: "course", courseId: "crs_1" }), "crs_1");

		const courses = [{ id: "crs_1" }];
		assert.deepEqual(reconcileCourseFilter({ kind: "course", courseId: "crs_1" }, courses, true), { kind: "course", courseId: "crs_1" });
		assert.deepEqual(reconcileCourseFilter({ kind: "course", courseId: "crs_missing" }, courses, true), { kind: "all" });
		assert.deepEqual(reconcileCourseFilter({ kind: "course", courseId: "crs_missing" }, courses, false), { kind: "course", courseId: "crs_missing" });
	});

	it("chatMatchesCourseFilter scopes All, No course (incl. deleted course ids), and specific courses", () => {
		const courses = [{ id: "crs_1" }];
		const membership = { c_assigned: "crs_1" };
		assert.equal(chatMatchesCourseFilter({ id: "c_assigned" }, { kind: "all" }, membership, courses, true), true);
		assert.equal(chatMatchesCourseFilter({ id: "c_free" }, { kind: "none" }, membership, courses, true), true);
		assert.equal(chatMatchesCourseFilter({ id: "c_assigned" }, { kind: "none" }, membership, courses, true), false);
		assert.equal(chatMatchesCourseFilter({ id: "c_orphan", courseId: "crs_gone" }, { kind: "none" }, membership, courses, true), true);
		assert.equal(chatMatchesCourseFilter({ id: "c_assigned" }, { kind: "course", courseId: "crs_1" }, membership, courses, true), true);
		assert.equal(chatMatchesCourseFilter({ id: "c_free" }, { kind: "course", courseId: "crs_1" }, membership, courses, true), false);
		// Once loaded, absence from membership means unassigned even with a stale chat.courseId
		assert.equal(effectiveChatCourseId({ id: "c_stale", courseId: "crs_1" }, membership, false), "crs_1");
		assert.equal(effectiveChatCourseId({ id: "c_stale", courseId: "crs_1" }, membership, true), null);
		assert.equal(chatMatchesCourseFilter({ id: "c_stale", courseId: "crs_1" }, { kind: "none" }, membership, courses, true), true);
		assert.equal(chatMatchesCourseFilter({ id: "c_stale", courseId: "crs_1" }, { kind: "course", courseId: "crs_1" }, membership, courses, true), false);
	});
});

describe("CoursesProvider fallback, persistence, and SSE refresh coalescing", () => {
	it("rescans a course restored from storage once on app load", async () => {
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_live");
		const posts: CourseRequest[] = [];
		globalThis.fetch = async (url, init) => {
			if (url !== "/api/courses") throw new Error(`unexpected fetch ${String(url)}`);
			if (init?.method === "POST") posts.push(JSON.parse(String(init.body)) as CourseRequest);
			return Response.json({ courses: [makeCourse("crs_live", "CV")], membership: {} } satisfies CoursesView);
		};
		function Probe() { useCourses(); return null; }
		await mountWithProviders(<Probe />);
		await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
		assert.deepEqual(posts, [{ action: "rescan", id: "crs_live" }]);
	});

	it("falls back to All and updates localStorage when the stored course no longer exists", async () => {
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_deleted");
		globalThis.fetch = async (url) => {
			if (url === "/api/courses") {
				return Response.json({ courses: [makeCourse("crs_live", "CV")], membership: {} } satisfies CoursesView);
			}
			throw new Error(`unexpected fetch ${String(url)}`);
		};
		let latestFilter!: ReturnType<typeof useCourses>["filter"];
		let latestLoaded = false;
		function Probe() {
			const c = useCourses();
			latestFilter = c.filter;
			latestLoaded = c.loaded;
			return <div data-testid="probe">{c.filter.kind}</div>;
		}
		await mountWithProviders(<Probe />);
		assert.equal(latestLoaded, true);
		assert.deepEqual(latestFilter, { kind: "all" });
		assert.equal(localStorageStub.getItem(COURSE_FILTER_STORAGE_KEY), "all");
	});

	it("queues a trailing refresh when courses-changed arrives while an initial fetch is in flight", async () => {
		let resolveFirst!: (res: Response) => void;
		let fetchCount = 0;
		let dispatchEvent!: (name: string, raw: string) => void;
		const hubSource = (): NotifySource => ({
			close() {},
			onOpen() {},
			onEvent(name, cb) {
				if (name === "courses-changed") dispatchEvent = (n, raw) => { if (n === "courses-changed") cb(raw); };
			},
		});
		globalThis.fetch = (url) => {
			if (url !== "/api/courses") throw new Error(`unexpected ${String(url)}`);
			fetchCount++;
			if (fetchCount === 1) {
				return new Promise<Response>((resolve) => { resolveFirst = resolve; });
			}
			return Promise.resolve(Response.json({ courses: [makeCourse("crs_new", "Updated")], membership: {} } satisfies CoursesView));
		};
		let latestCourses: CourseView[] = [];
		let latestRev = 0;
		function Probe() {
			const c = useCourses();
			latestCourses = c.courses;
			latestRev = c.revision;
			return null;
		}
		await mountWithProviders(<Probe />, { connect: hubSource });
		assert.equal(fetchCount, 1);
		await act(async () => {
			dispatchEvent("courses-changed", "{}");
			resolveFirst(Response.json({ courses: [], membership: {} } satisfies CoursesView));
		});
		assert.equal(fetchCount, 2);
		assert.deepEqual(latestCourses.map((c) => c.name), ["Updated"]);
		assert.ok(latestRev >= 1);
	});
});

describe("CourseSwitcher & rescan POST", () => {
	it("shows All / No course / courses / New course… and POSTs {action:'rescan', id} once per switch to a course", async () => {
		const posts: CourseRequest[] = [];
		let view: CoursesView = {
			courses: [makeCourse("crs_cv", "Computer Vision"), makeCourse("crs_dl", "Deep Learning")],
			membership: {},
		};
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && (!init?.method || init.method === "GET")) return Response.json(view);
			if (url === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				posts.push(body);
				if (body.action === "create") {
					view = { ...view, courses: [...view.courses, makeCourse("crs_vla", body.name)] };
				}
				return Response.json(view);
			}
			throw new Error(`unexpected ${String(url)}`);
		};
		const openedPanels: string[] = [];
		await mountWithProviders(<CourseSwitcher onOpenPanel={(id) => openedPanels.push(id)} />);

		assert.equal(document.querySelector('[data-testid="course-panel-button"]'), null, "gear hidden on All");
		await clickTestId("course-switcher-trigger");
		assert.ok(document.querySelector('[data-testid="course-option-all"]'));
		assert.ok(document.querySelector('[data-testid="course-option-none"]'));
		assert.ok(document.querySelector('[data-testid="course-option-crs_cv"]'));
		assert.ok(document.querySelector('[data-testid="course-option-crs_dl"]'));
		assert.ok(document.querySelector('[data-testid="course-option-new"]'));

		// Switch All -> CV: POSTs rescan once
		await clickTestId("course-option-crs_cv");
		assert.deepEqual(posts, [{ action: "rescan", id: "crs_cv" }]);
		assert.ok(document.querySelector('[data-testid="course-panel-button"]'), "gear appears for active course");
		await clickTestId("course-panel-button");
		assert.deepEqual(openedPanels, ["crs_cv"]);

		// Clicking already-active CV does NOT rescan again
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-crs_cv");
		assert.equal(posts.length, 1);

		// Switching to No course does NOT rescan
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-none");
		assert.equal(posts.length, 1);

		// Switching None -> DL rescans DL once
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-crs_dl");
		assert.deepEqual(posts, [
			{ action: "rescan", id: "crs_cv" },
			{ action: "rescan", id: "crs_dl" },
		]);

		// New course… dialog creates and activates the new course
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-new");
		const input = document.querySelector<HTMLInputElement>('[data-testid="new-course-name-input"]')!;
		assert.ok(input);
		await act(async () => { setInputValue(input, "VLA"); });
		await act(async () => {
			input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.equal(posts.some((p) => p.action === "create" && p.name === "VLA"), true);
		assert.match(document.querySelector('[data-testid="course-switcher-trigger"]')!.textContent!, /VLA/);
	});
});

describe("SessionsSidebar filtering, empty state, and Move to course", () => {
	it("filters sessions by active course, shows empty hint for empty course, and Move to course POSTs assign", async () => {
		localStorageStub.setItem("lh:sidebar-open", "1");
		let view: CoursesView = {
			courses: [makeCourse("crs_cv", "CV"), makeCourse("crs_empty", "Empty Course")],
			membership: { c_cv: "crs_cv" },
		};
		const chats: ChatListItem[] = [
			makeChat("c_cv", "Convolution Lecture", "crs_cv"),
			makeChat("c_free", "Random Chat", null),
		];
		const coursePosts: CourseRequest[] = [];
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && (!init?.method || init.method === "GET")) return Response.json(view);
			if (url === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				coursePosts.push(body);
				if (body.action === "assign") {
					const nextMembership = { ...view.membership };
					if (body.courseId === null) delete nextMembership[body.sourceId];
					else nextMembership[body.sourceId] = body.courseId;
					view = { ...view, membership: nextMembership };
					const chat = chats.find((c) => c.id === body.sourceId);
					if (chat) chat.courseId = body.courseId;
				}
				return Response.json(view);
			}
			if (url === "/api/chats") return Response.json({ chats });
			if (url === "/api/activity") return Response.json({ jobs: [], extractions: [], pluginWorkers: [] });
			if (String(url).startsWith("/api/chats/") && String(url).endsWith("/coverage")) {
				return Response.json({ covered: 0, total: 0 });
			}
			return Response.json({});
		};

		await mountWithProviders(<SessionsSidebar />, { withShellContexts: true });
		const rowTitles = () => [...document.querySelectorAll('[data-testid="session-row"]')].map((el) => el.textContent);

		// All shows both chats
		assert.equal(rowTitles().length, 2);

		// Switch to No course -> only Random Chat
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-none");
		assert.equal(rowTitles().length, 1);
		assert.match(rowTitles()[0]!, /Random Chat/);

		// Switch to CV -> only Convolution Lecture
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-crs_cv");
		assert.equal(rowTitles().length, 1);
		assert.match(rowTitles()[0]!, /Convolution Lecture/);

		// Right-click Convolution Lecture -> Move to course -> Empty Course
		const row = document.querySelector<HTMLElement>('[data-testid="session-row"]')!;
		await act(async () => {
			row.dispatchEvent(new dom.window.Event("contextmenu", { bubbles: true, cancelable: true }));
		});
		await clickTestId("ctx-move-course");
		assert.ok(document.querySelector('[data-testid="ctx-move-course-none"]'));
		assert.ok(document.querySelector('[data-testid="ctx-move-course-crs_cv"]'));
		assert.ok(document.querySelector('[data-testid="ctx-move-course-crs_empty"]'));
		await clickTestId("ctx-move-course-crs_empty");

		assert.deepEqual(
			coursePosts.find((p) => p.action === "assign"),
			{ action: "assign", sourceId: "c_cv", courseId: "crs_empty" },
		);

		// CV now has 0 sessions -> shows empty hint with attach-a-folder trigger opening CoursePanelDialog
		assert.ok(document.querySelector('[data-testid="course-empty-hint"]'));
		assert.match(document.querySelector('[data-testid="course-empty-hint"]')!.textContent!, /Start a session/);
		await clickTestId("course-empty-attach");
		assert.ok(document.querySelector('[data-testid="course-panel-dialog"]'));
	});

	it("shows a session moved to No course in No course without refetching /api/chats", async () => {
		localStorageStub.setItem("lh:sidebar-open", "1");
		let view: CoursesView = {
			courses: [makeCourse("crs_cv", "CV")],
			membership: { c_cv: "crs_cv" },
		};
		// /api/chats keeps returning stale courseId: "crs_cv" to prove sidebar trusts loaded membership
		const chats: ChatListItem[] = [makeChat("c_cv", "Convolution Lecture", "crs_cv")];
		let chatsFetchCount = 0;
		let dispatchCoursesChanged!: () => void;
		const hubSource = (): NotifySource => ({
			close() {},
			onOpen() {},
			onEvent(name, cb) {
				if (name === "courses-changed") dispatchCoursesChanged = () => cb("{}");
			},
		});
		globalThis.fetch = async (url) => {
			if (url === "/api/courses") return Response.json(view);
			if (url === "/api/chats") {
				chatsFetchCount++;
				return Response.json({ chats });
			}
			if (url === "/api/activity") return Response.json({ jobs: [], extractions: [], pluginWorkers: [] });
			if (String(url).startsWith("/api/chats/") && String(url).endsWith("/coverage")) {
				return Response.json({ covered: 0, total: 0 });
			}
			return Response.json({});
		};

		await mountWithProviders(<SessionsSidebar />, { withShellContexts: true, connect: hubSource });
		const rowTitles = () => [...document.querySelectorAll('[data-testid="session-row"]')].map((el) => el.textContent);

		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-none");
		assert.equal(rowTitles().length, 0, "before move, c_cv is not in No course");

		const initialChatsFetches = chatsFetchCount;
		// Server updates courses membership (moving c_cv to No course) without any /api/chats refetch
		view = { courses: [makeCourse("crs_cv", "CV")], membership: {} };
		await act(async () => { dispatchCoursesChanged(); });

		assert.equal(chatsFetchCount, initialChatsFetches, "/api/chats must not be refetched");
		assert.equal(rowTitles().length, 1, "c_cv appears in No course immediately");
		assert.match(rowTitles()[0]!, /Convolution Lecture/);

		// Switching to CV no longer shows c_cv either
		await clickTestId("course-switcher-trigger");
		await clickTestId("course-option-crs_cv");
		assert.equal(rowTitles().length, 0);
	});
});

describe("CoursePanelDialog & DeleteCourseDialog", () => {
	it("supports rename, included courses cycle errors, folders, per-file statuses, scanning, rescan, and delete modes", async () => {
		const posts: CourseRequest[] = [];
		let view: CoursesView = {
			courses: [
				makeCourse("crs_cv", "CV", {
					includes: [],
					folders: [{ id: "cfld_1", path: "/notes/cv", addedAt: "2026-11-20T00:00:00.000Z" }],
					files: [
						{ path: "/notes/cv/w1.md", folderId: "cfld_1", state: "queued" },
						{ path: "/notes/cv/w2.pdf", folderId: "cfld_1", state: "extracting" },
						{ path: "/notes/cv/w3.txt", folderId: "cfld_1", state: "extracted" },
						{ path: "/notes/cv/bad.pdf", folderId: "cfld_1", state: "failed", error: "OCR not supported yet." },
					],
					scanning: true,
					ownSourceIds: ["c_1"],
				}),
				makeCourse("crs_vla", "VLA", { includes: ["crs_cv"] }),
			],
			membership: { c_1: "crs_cv" },
		};
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && (!init?.method || init.method === "GET")) return Response.json(view);
			if (url === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				posts.push(body);
				if (body.action === "set-includes" && body.includes.includes("crs_vla")) {
					return Response.json({ error: "A course cannot include itself, directly or through another course." }, { status: 400 });
				}
				if (body.action === "add-folder") {
					if (!body.path.startsWith("/")) return Response.json({ error: "Folder path must be an absolute path." }, { status: 400 });
					view = {
						...view,
						courses: view.courses.map((c) => c.id === body.id ? {
							...c,
							folders: [...c.folders, { id: "cfld_2", path: body.path, addedAt: "2026-11-20T00:00:00.000Z" }],
						} : c),
					};
				} else if (body.action === "remove-folder") {
					view = {
						...view,
						courses: view.courses.map((c) => c.id === body.id ? { ...c, folders: c.folders.filter((f) => f.id !== body.folderId) } : c),
					};
				} else if (body.action === "rename") {
					view = { ...view, courses: view.courses.map((c) => c.id === body.id ? { ...c, name: body.name } : c) };
				} else if (body.action === "delete") {
					view = { ...view, courses: view.courses.filter((c) => c.id !== body.id), membership: {} };
				}
				return Response.json(view);
			}
			throw new Error(`unexpected ${String(url)}`);
		};

		let closed = false;
		const deletedCalls: Array<{ mode: string; ownIds: string[] }> = [];
		await mountWithProviders(
			<CoursePanelDialog
				courseId="crs_cv"
				open
				onClose={() => { closed = true; }}
				onDeletedCourse={(mode, ownIds) => deletedCalls.push({ mode, ownIds })}
			/>,
		);

		// Scanning indicator + per-file statuses
		assert.ok(document.querySelector('[data-testid="course-scanning-indicator"]'));
		assert.equal((document.querySelector('[data-testid="course-rescan"]') as HTMLButtonElement).disabled, true);
		const states = [...document.querySelectorAll('[data-testid="course-file-state"]')].map((e) => e.textContent);
		assert.deepEqual(states, ["Queued", "Extracting…", "Extracted", "Failed"]);
		assert.match(document.querySelector('[data-testid="course-file-error"]')!.textContent!, /OCR not supported yet/);

		// Rename
		const renameInput = document.querySelector<HTMLInputElement>('[data-testid="course-rename-input"]')!;
		await act(async () => { setInputValue(renameInput, "Computer Vision"); });
		await act(async () => {
			renameInput.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(posts.at(-1), { action: "rename", id: "crs_cv", name: "Computer Vision" });

		// Cycle error on Included courses
		await clickTestId("course-include-crs_vla");
		assert.match(document.querySelector('[data-testid="course-includes-error"]')!.textContent!, /cannot include itself/);

		// Folder validation error then valid add + remove
		const folderInput = document.querySelector<HTMLInputElement>('[data-testid="course-folder-input"]')!;
		await act(async () => { setInputValue(folderInput, "relative/dir"); });
		await act(async () => {
			folderInput.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.match(document.querySelector('[data-testid="course-folder-error"]')!.textContent!, /absolute path/);

		await act(async () => { setInputValue(folderInput, "/notes/cv2"); });
		await act(async () => {
			folderInput.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(posts.at(-1), { action: "add-folder", id: "crs_cv", path: "/notes/cv2" });
		await clickTestId("course-folder-remove-cfld_1");
		assert.deepEqual(posts.at(-1), { action: "remove-folder", id: "crs_cv", folderId: "cfld_1" });

		// Delete dialog: verify both options, destructive styling, and delete-sources POST
		await clickTestId("course-panel-delete");
		const delDialog = document.querySelector('[data-testid="delete-course-dialog"]')!;
		assert.ok(delDialog);
		assert.match(delDialog.textContent!, /Ungroup only \(sessions move to No course\)/);
		assert.match(delDialog.textContent!, /Also delete this course's sessions and files/);
		assert.match(document.querySelector('[data-testid="course-delete-confirm"]')!.className, /border-destructive\/50 bg-destructive\/10/);
		await clickTestId("delete-course-mode-delete-sources");
		await clickTestId("course-delete-confirm");
		assert.deepEqual(posts.at(-1), { action: "delete", id: "crs_cv", mode: "delete-sources" });
		assert.equal(closed, true);
		assert.deepEqual(deletedCalls, [{ mode: "delete-sources", ownIds: ["c_1"] }]);
	});

	it("DeleteCourseBody + DeleteCourseDialog support ungroup mode cleanly", async () => {
		const html = renderToStaticMarkup(
			<DeleteCourseBody
				course={{ id: "crs_1", name: "Physics" }}
				mode="ungroup"
				onModeChange={() => {}}
				busy={false}
				failure=""
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.match(html, /text-destructive">Delete course\?<\/h2>/);
		assert.match(html, /Ungroup only \(sessions move to No course\)/);
		assert.match(html, /Also delete this course&#x27;s sessions and files/);

		const modes: string[] = [];
		await mountWithProviders(
			<DeleteCourseDialog
				open
				course={{ id: "crs_1", name: "Physics" }}
				onDelete={async (mode) => { modes.push(mode); }}
				onClose={() => {}}
			/>,
		);
		await clickTestId("course-delete-confirm");
		assert.deepEqual(modes, ["ungroup"]);
	});

	it("CoursePanelDialog Rescan button POSTs {action:'rescan', id} when idle", async () => {
		const posts: CourseRequest[] = [];
		let view: CoursesView = { courses: [makeCourse("crs_cv", "CV", { scanning: false })], membership: {} };
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses" && (!init?.method || init.method === "GET")) return Response.json(view);
			if (url === "/api/courses" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as CourseRequest;
				posts.push(body);
				if (body.action === "rescan") {
					view = { ...view, courses: view.courses.map((c) => c.id === body.id ? { ...c, scanning: true } : c) };
				}
				return Response.json(view);
			}
			return Response.json({});
		};
		await mountWithProviders(<CoursePanelDialog courseId="crs_cv" open onClose={() => {}} />);
		const btn = document.querySelector<HTMLButtonElement>('[data-testid="course-rescan"]')!;
		assert.equal(btn.disabled, false);
		await clickTestId("course-rescan");
		assert.deepEqual(posts, [{ action: "rescan", id: "crs_cv" }]);
	});

	it("CoursePanelDialog renders file decode notices muted under extracted rows", async () => {
		const view: CoursesView = {
			courses: [
				makeCourse("crs_cv", "CV", {
					folders: [{ id: "cfld_1", path: "/notes/cv", addedAt: "2026-11-20T00:00:00.000Z" }],
					files: [
						{
							path: "/notes/cv/slides.pdf",
							folderId: "cfld_1",
							state: "extracted",
							notice: "Scanned pages may have errors. Skipped 1 image-only page; OCR is not supported.",
						},
					],
				}),
			],
			membership: {},
		};
		globalThis.fetch = async (url) => {
			if (url === "/api/courses") return Response.json(view);
			return Response.json({});
		};
		await mountWithProviders(<CoursePanelDialog courseId="crs_cv" open onClose={() => {}} />);
		const notice = document.querySelector('[data-testid="course-file-notice"]');
		assert.ok(notice);
		assert.match(notice.className, /text-muted-foreground/);
		assert.equal(notice.textContent, "Scanned pages may have errors. Skipped 1 image-only page; OCR is not supported.");
	});
});

describe("New sessions carry active courseId", () => {
	it("Home sends active courseId (and null for All / No course) for teach and practice sessions", async () => {
		const createdBodies: Array<Record<string, unknown>> = [];
		const slot = { model: { provider: "p", id: "m1" }, thinkingLevel: "off" };
		globalThis.fetch = async (url, init) => {
			if (url === "/api/courses") {
				return Response.json({ courses: [makeCourse("crs_cv", "CV")], membership: {} } satisfies CoursesView);
			}
			if (url === "/api/models") {
				return Response.json({
					models: [{ id: "m1", provider: "p", name: "m1", input: ["text"], reasoning: false, supportedLevels: ["off"], maxTokens: 1000, contextWindow: 8000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
					providers: [{ id: "p", name: "P", keyPresent: true }],
					defaults: null,
					slots: { strong: slot, cheap: slot, vision: slot },
					rolePins: {},
				});
			}
			if (url === "/api/graph" || String(url).startsWith("/api/graph?")) {
				return Response.json({ nodes: [], propositions: [], edges: [], logicalEdges: [], impLinks: [], chains: [], sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [] });
			}
			if (url === "/api/graph/render-settings") return Response.json({});
			if (url === "/api/graph/status") return Response.json({ runs: [] });
			if (url === "/api/graph/costs") return Response.json({ stages: { extraction: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} }, audit: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} } }, runs: [] });
			if (url === "/api/chats" && (!init?.method || init.method === "GET")) return Response.json({ chats: [] });
			if (url === "/api/chats" && init?.method === "POST") {
				createdBodies.push(JSON.parse(String(init.body)));
				return Response.json({ id: `chat_${createdBodies.length}` });
			}
			if (url === "/api/plugins") return Response.json({ plugins: [], directory: "/tmp" });
			if (url === "/api/settings") return Response.json({ settings: { models: {} } });
			return Response.json({});
		};

		const submitHome = async (storageFilter: string, mode: "teach" | "practice", prompt: string) => {
			if (root) {
				await act(async () => { root?.unmount(); });
				root = undefined;
				host?.remove();
				host = undefined;
			}
			localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, storageFilter);
			await mountWithProviders(<Home initialConfigured rendering={false} />, { withShellContexts: true });
			if (mode === "practice") await clickTestId("home-mode-practice");
			const textbox = document.querySelector<HTMLElement>('[role="textbox"]')!;
			assert.ok(textbox);
			await act(async () => {
				textbox.textContent = prompt;
				textbox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			});
			const form = textbox.closest("form")!;
			await act(async () => {
				form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
			});
		};

		await submitHome("course:crs_cv", "teach", "Explain convolutions");
		assert.deepEqual(createdBodies[0], { title: "Explain convolutions", courseId: "crs_cv" });
		assert.equal(pushedRoutes[0], "/chat/chat_1");

		await submitHome("course:crs_cv", "practice", "Drill backprop");
		assert.deepEqual(createdBodies[1], { title: "Drill backprop", courseId: "crs_cv", kind: "practice" });

		await submitHome("all", "teach", "Unscoped topic");
		assert.deepEqual(createdBodies[2], { title: "Unscoped topic", courseId: null });

		await submitHome("none", "teach", "No course topic");
		assert.deepEqual(createdBodies[3], { title: "No course topic", courseId: null });
	});

	it("startDraftSession and SessionStarter propagate courseId (string or null) and isolate retry identity by courseId", async () => {
		const bodies: unknown[] = [];
		const f = (async (_url: string, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: `c_${bodies.length}` }), { status: 200 });
		}) as typeof fetch;

		const starter = new SessionStarter();
		await startDraftSession("Learn VLA", f, undefined, undefined, starter, undefined, "crs_vla");
		await startDraftSession("Learn VLA", f, undefined, undefined, starter, undefined, null);
		await startDraftSession("Practice CV", f, "practice", undefined, new SessionStarter(), undefined, "crs_cv");

		assert.deepEqual(bodies, [
			{ title: "Learn VLA", courseId: "crs_vla" },
			{ title: "Learn VLA", courseId: null },
			{ title: "Practice CV", kind: "practice", courseId: "crs_cv" },
		]);
	});
});

describe("Home graph, MinimalHome, Practice picker & ChainTableOverlay scoping", () => {
	it("GraphView fetches ?course=, recovers from 404 stale course, dims inherited nodes while keeping positions, and lists node courses", async t => {
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_stale");
		const canvasProto = Object.getPrototypeOf(dom.document.createElement("canvas"));
		const prevGetContext = Object.getOwnPropertyDescriptor(canvasProto, "getContext");
		Object.defineProperty(canvasProto, "getContext", {
			configurable: true,
			value() {
				return {
					fillStyle: "#000000", setTransform() {}, fillRect() {},
					getImageData(this: { fillStyle: string }) {
						const hex = this.fillStyle.slice(1);
						return { data: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255) };
					},
				};
			},
		});
		const feeds: CanvasData[] = [];
		t.mock.method(GraphCanvasRenderer.prototype, "setData", function (data: CanvasData) { feeds.push(data); });
		for (const m of ["setSettings", "setVisible", "setRegionTuning", "setPhysicsTuning"] as const) {
			t.mock.method(GraphCanvasRenderer.prototype, m, () => {});
		}

		const graphUrls: string[] = [];
		let coursesCalls = 0;
		const snapshot: GraphSnapshot = {
			nodes: [
				{ id: "n_own", name: "Own", statement: "Own fact", aliases: [], createdAt: "2026-11-20", provenance: [], inherited: false, courses: ["crs_vla"] },
				{ id: "n_inh", name: "Inherited", statement: "CV fact", aliases: [], createdAt: "2026-11-20", provenance: [], inherited: true, courses: ["crs_cv"] },
			],
			propositions: [],
			edges: [],
			logicalEdges: [],
			impLinks: [],
			chains: [],
			sessions: {},
			fileSources: {},
			nodeSessions: {},
			clusters: [],
			positions: { n_own: { x: 100, y: 200 }, n_inh: { x: 300, y: 400 } },
		};

		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u === "/api/courses") {
				coursesCalls++;
				return Response.json({
					courses: [makeCourse("crs_vla", "VLA", { includes: ["crs_cv"] }), makeCourse("crs_cv", "CV")],
					membership: {},
				} satisfies CoursesView);
			}
			if (u === "/api/graph?course=crs_stale") {
				graphUrls.push(u);
				return Response.json({ error: "Course not found." }, { status: 404 });
			}
			if (u === "/api/graph" || u === "/api/graph?course=crs_vla") {
				graphUrls.push(u);
				return Response.json(snapshot);
			}
			if (u === "/api/graph/render-settings") return Response.json({});
			if (u === "/api/graph/status") return Response.json({ runs: [] });
			if (u === "/api/graph/costs") return Response.json(null);
			return Response.json({});
		};

		try {
			await mountWithProviders(
				<>
					<CourseSwitcher onOpenPanel={() => {}} />
					<GraphView />
				</>,
			);
			// Stale course recovered to All without crashing and fetched /api/graph
			assert.ok(coursesCalls >= 1);
			assert.equal(graphUrls.includes("/api/graph"), true);

			// Switch to VLA -> fetches /api/graph?course=crs_vla and feeds inherited + same positions to renderer
			await clickTestId("course-switcher-trigger");
			await clickTestId("course-option-crs_vla");
			assert.equal(graphUrls.includes("/api/graph?course=crs_vla"), true);
			const lastFeed = feeds.at(-1)!;
			assert.deepEqual(
				lastFeed.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, inherited: n.inherited })),
				[
					{ id: "n_own", x: 100, y: 200, inherited: undefined },
					{ id: "n_inh", x: 300, y: 400, inherited: true },
				],
			);

			// Pure card course resolution & markup check
			const names = resolveNodeCourseNames(["crs_vla", "crs_cv"], [makeCourse("crs_vla", "VLA"), makeCourse("crs_cv", "CV")]);
			assert.deepEqual(names, ["VLA", "CV"]);
			const cardHtml = renderToStaticMarkup(<NodeCardCourses courses={names} />);
			assert.match(cardHtml, /data-testid="node-card-courses"/);
			assert.match(cardHtml, /VLA/);
			assert.match(cardHtml, /CV/);
			assert.equal(renderToStaticMarkup(<NodeCardCourses courses={[]} />), "");
			assert.equal(toCanvasNode({ id: "n1", name: "X", inherited: true }, { x: 1, y: 2 }).inherited, true);
			assert.equal(INHERITED_NODE_ALPHA < 0.5, true);
		} finally {
			t.mock.restoreAll();
			if (prevGetContext) Object.defineProperty(canvasProto, "getContext", prevGetContext);
			else Reflect.deleteProperty(canvasProto, "getContext");
		}
	});

	it("MinimalHome fetches /api/graph?course=, scopes session counts, and shows course empty hint", async () => {
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_cv");
		const graphUrls: string[] = [];
		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u === "/api/courses") {
				return Response.json({ courses: [makeCourse("crs_cv", "CV")], membership: { c1: "crs_cv" } } satisfies CoursesView);
			}
			if (u.startsWith("/api/graph/costs")) return Response.json({ stages: { extraction: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} }, audit: { runs: 0, dollars: 0, unpricedRuns: 0, tokens: {} } }, runs: [] });
			if (u.startsWith("/api/graph")) {
				graphUrls.push(u);
				return Response.json({ nodes: [], propositions: [], chains: [], sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [] });
			}
			if (u === "/api/chats") {
				return Response.json({ chats: [makeChat("c1", "CV Chat", "crs_cv"), makeChat("c2", "Other", null)] });
			}
			return Response.json({});
		};
		await mountWithProviders(<MinimalHome />);
		assert.equal(graphUrls.includes("/api/graph?course=crs_cv"), true);
		const summary = document.querySelector('[data-testid="knowledge-summary"]')!.textContent!;
		assert.match(summary, /1 teaching session/);
		assert.doesNotMatch(summary, /2 teaching sessions/);
	});

	it("ChainTableOverlay & PluginKnowledgePicker scope /api/graph/sources?course= and /api/graph?course=, hiding out-of-course folders", async () => {
		// Pure folder scoping check
		const fullDir: SourceDirectory = {
			organization: {
				version: 1,
				folders: [
					{ id: "f_cv", name: "cv_notes", parentId: null, createdAt: "2026-11-20", importPath: "cv_notes" },
					{ id: "f_bio", name: "bio_notes", parentId: null, createdAt: "2026-11-20", importPath: "bio_notes" },
					{ id: "f_user", name: "My Empty Folder", parentId: null, createdAt: "2026-11-20" },
				],
				placements: {
					src_cv: { folderId: "f_cv" },
					src_bio: { folderId: "f_bio" },
				},
			},
			sources: [{ id: "src_cv", kind: "notes", label: "CV Slides", createdAt: "2026-11-20" }],
		};
		const scoped = scopeSourceDirectoryFolders(fullDir);
		assert.deepEqual(scoped.organization.folders.map((f) => f.id), ["f_cv", "f_user"]);

		// Live ChainTableOverlay + PluginKnowledgePicker check
		localStorageStub.setItem(COURSE_FILTER_STORAGE_KEY, "course:crs_cv");
		const fetchedUrls: string[] = [];
		globalThis.fetch = async (url) => {
			const u = String(url);
			fetchedUrls.push(u);
			if (u === "/api/courses") {
				return Response.json({ courses: [makeCourse("crs_cv", "CV")], membership: {} } satisfies CoursesView);
			}
			if (u.startsWith("/api/graph/sources")) return Response.json(fullDir);
			if (u.startsWith("/api/graph")) {
				return Response.json({
					nodes: [], propositions: [], edges: [], logicalEdges: [], impLinks: [], chains: [],
					sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [],
				});
			}
			return Response.json({});
		};

		await mountWithProviders(
			<>
				<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => {}} />
				<PluginKnowledgePicker value={[]} onChange={() => {}} signal={new AbortController().signal} onError={() => {}} />
			</>,
			{ withShellContexts: true },
		);
		assert.equal(fetchedUrls.includes("/api/graph/sources?course=crs_cv"), true);
		assert.ok(document.querySelector('[data-testid="folder-row-f_cv"]'));
		assert.equal(document.querySelector('[data-testid="folder-row-f_bio"]'), null, "out-of-course folder hidden");

		await clickTestId("practice-props-chip");
		assert.equal(fetchedUrls.includes("/api/graph?course=crs_cv"), true);
	});
});
