"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import type { CourseFilesResponse, CourseFilter, CourseRequest, CourseView, CoursesView } from "@/src/core";
import { useNotifyHub } from "@/components/server-events";

export const COURSE_FILTER_STORAGE_KEY = "lh:active-course";
export const COURSE_ATTACH_MODE_STORAGE_PREFIX = "lh:attach-mode:";

export type CourseAttachMode = "session" | "course";

export type CourseAttachTarget =
	| { kind: "chat"; chatId: string }
	| { kind: "draft"; onStageFiles: (paths: readonly string[]) => void };

export function courseAttachModeKey(courseId: string): string {
	return `${COURSE_ATTACH_MODE_STORAGE_PREFIX}${courseId}`;
}

/** Read remembered paperclip/drop mode for a course ("session" default). */
export function readCourseAttachMode(courseId: string): CourseAttachMode {
	try {
		return window.localStorage.getItem(courseAttachModeKey(courseId)) === "course" ? "course" : "session";
	} catch {
		return "session";
	}
}

/** Persist paperclip/drop mode for a course in localStorage. */
export function writeCourseAttachMode(courseId: string, mode: CourseAttachMode): void {
	try {
		window.localStorage.setItem(courseAttachModeKey(courseId), mode);
	} catch {
		// localStorage unavailable in restricted contexts
	}
}

/** Upload files to POST /api/courses/files (multipart/form-data). */
export async function postCourseFiles(
	courseId: string,
	files: readonly File[],
	chatId?: string,
): Promise<CourseFilesResponse> {
	const form = new FormData();
	form.append("courseId", courseId);
	for (const file of files) form.append("files", file);
	if (chatId) form.append("chatId", chatId);
	const res = await fetch("/api/courses/files", { method: "POST", body: form });
	const body = (await res.json().catch(() => ({}))) as Partial<CourseFilesResponse> & { error?: unknown };
	if (!res.ok) {
		throw new Error(typeof body.error === "string" ? body.error : `Failed to add course files (${res.status})`);
	}
	return {
		courses: Array.isArray(body.courses) ? body.courses : [],
		membership: body.membership && typeof body.membership === "object" ? body.membership : {},
		copied: Array.isArray(body.copied) ? body.copied.filter((p): p is string => typeof p === "string") : [],
	};
}

const ALL_FILTER: CourseFilter = { kind: "all" };
const NONE_FILTER: CourseFilter = { kind: "none" };

/** Parse a persisted course filter value; unrecognized empty/missing values default to All. */
export function parseStoredCourseFilter(raw: string | null): CourseFilter {
	if (!raw || raw === "all") return ALL_FILTER;
	if (raw === "none") return NONE_FILTER;
	const id = raw.startsWith("course:") ? raw.slice("course:".length) : raw;
	return id ? { kind: "course", courseId: id } : ALL_FILTER;
}

/** Serialize a CourseFilter for localStorage persistence. */
export function serializeCourseFilter(filter: CourseFilter): string {
	if (filter.kind === "all") return "all";
	if (filter.kind === "none") return "none";
	return `course:${filter.courseId}`;
}

/** Fall back to All once the course list is loaded if the active course no longer exists. */
export function reconcileCourseFilter(
	filter: CourseFilter,
	courses: readonly Pick<CourseView, "id">[],
	loaded: boolean,
): CourseFilter {
	if (!loaded || filter.kind !== "course") return filter;
	return courses.some((c) => c.id === filter.courseId) ? filter : ALL_FILTER;
}

/** Query suffix for /api/graph and /api/graph/sources (?course=<id>|none, empty for All). */
export function courseQueryParam(filter: CourseFilter): string {
	if (filter.kind === "all") return "";
	if (filter.kind === "none") return "?course=none";
	return `?course=${encodeURIComponent(filter.courseId)}`;
}

/** Course id stamped on newly created sessions (null for All / No course). */
export function activeCourseIdOf(filter: CourseFilter): string | null {
	return filter.kind === "course" ? filter.courseId : null;
}

/** Resolve a chat's effective course id; once course membership has loaded,
 * absence from `membership` means unassigned (never fall back to stale chat.courseId). */
export function effectiveChatCourseId(
	chat: { id: string; courseId?: string | null },
	membership: Readonly<Record<string, string>>,
	loaded = false,
): string | null {
	if (Object.hasOwn(membership, chat.id)) return membership[chat.id]!;
	return loaded ? null : (chat.courseId ?? null);
}

/** Whether a chat row is visible in the sidebar/home summary under the active course filter. */
export function chatMatchesCourseFilter(
	chat: { id: string; courseId?: string | null },
	filter: CourseFilter,
	membership: Readonly<Record<string, string>>,
	courses?: readonly Pick<CourseView, "id">[],
	loaded = false,
): boolean {
	if (filter.kind === "all") return true;
	const cid = effectiveChatCourseId(chat, membership, loaded);
	if (filter.kind === "none") {
		if (cid === null) return true;
		return loaded && courses !== undefined && !courses.some((c) => c.id === cid);
	}
	return cid === filter.courseId;
}

/** Resolve which course attachments belong to: an open chat uses its own
 * course from membership (null if unassigned); drafts use activeCourseId. */
export function resolveCourseAttachCourseId(
	target: CourseAttachTarget | null,
	membership: Readonly<Record<string, string>>,
	activeCourseId: string | null,
	explicitChatId?: string,
): string | null {
	const chatId = explicitChatId ?? (target?.kind === "chat" ? target.chatId : undefined);
	if (chatId) return Object.hasOwn(membership, chatId) ? membership[chatId]! : null;
	return activeCourseId;
}

export interface CoursesContextValue {
	courses: CourseView[];
	membership: Record<string, string>;
	loaded: boolean;
	filter: CourseFilter;
	activeCourse: CourseView | null;
	activeCourseId: string | null;
	attachTarget: CourseAttachTarget | null;
	revision: number;
	setFilter: (next: CourseFilter) => void;
	refresh: () => Promise<void>;
	mutate: (request: CourseRequest) => Promise<CoursesView>;
	uploadFiles: (courseId: string, files: readonly File[], chatId?: string) => Promise<CourseFilesResponse>;
	registerAttachTarget: (target: CourseAttachTarget) => () => void;
	getAttachTarget: () => CourseAttachTarget | null;
}

const DEFAULT_CONTEXT: CoursesContextValue = {
	courses: [],
	membership: {},
	loaded: false,
	filter: ALL_FILTER,
	activeCourse: null,
	activeCourseId: null,
	attachTarget: null,
	revision: 0,
	setFilter: () => {},
	refresh: async () => {},
	mutate: async () => ({ courses: [], membership: {} }),
	uploadFiles: (courseId, files, chatId) => postCourseFiles(courseId, files, chatId),
	registerAttachTarget: () => () => {},
	getAttachTarget: () => null,
};

const CoursesContext = createContext<CoursesContextValue>(DEFAULT_CONTEXT);

export function useCourses(): CoursesContextValue {
	return useContext(CoursesContext);
}

/** Register the current page's chat or draft target for FilePathDropZone. */
export function useCourseAttachTarget(target: CourseAttachTarget | null): void {
	const { registerAttachTarget } = useCourses();
	const targetRef = useRef(target);
	targetRef.current = target;
	const kind = target?.kind ?? null;
	const chatId = target?.kind === "chat" ? target.chatId : undefined;
	useEffect(() => {
		if (!kind) return;
		const entry: CourseAttachTarget =
			kind === "chat"
				? { kind: "chat", chatId: chatId! }
				: {
					kind: "draft",
					onStageFiles: (paths) => {
						if (targetRef.current?.kind === "draft") targetRef.current.onStageFiles(paths);
					},
				};
		return registerAttachTarget(entry);
	}, [registerAttachTarget, kind, chatId]);
}

function readStoredFilter(): CourseFilter {
	try {
		return parseStoredCourseFilter(window.localStorage.getItem(COURSE_FILTER_STORAGE_KEY));
	} catch {
		return ALL_FILTER;
	}
}

function writeStoredFilter(filter: CourseFilter): void {
	try {
		window.localStorage.setItem(COURSE_FILTER_STORAGE_KEY, serializeCourseFilter(filter));
	} catch {
		// localStorage unavailable in restricted contexts
	}
}

export function CoursesProvider({ children }: { children: ReactNode }) {
	const hub = useNotifyHub();
	const [courses, setCourses] = useState<CourseView[]>([]);
	const [membership, setMembership] = useState<Record<string, string>>({});
	const [loaded, setLoaded] = useState(false);
	// Start at All so SSR and first client render agree before reading localStorage.
	const [filter, setFilterState] = useState<CourseFilter>(ALL_FILTER);
	const [revision, setRevision] = useState(0);
	const filterRef = useRef(filter);
	filterRef.current = filter;

	const applyView = useCallback((view: CoursesView, bumpRevision: boolean) => {
		setCourses(view.courses);
		setMembership(view.membership);
		setLoaded(true);
		const reconciled = reconcileCourseFilter(filterRef.current, view.courses, true);
		if (reconciled !== filterRef.current) {
			filterRef.current = reconciled;
			setFilterState(reconciled);
			writeStoredFilter(reconciled);
		}
		if (bumpRevision) setRevision((r) => r + 1);
	}, []);

	useLayoutEffect(() => {
		const restored = readStoredFilter();
		filterRef.current = restored;
		setFilterState(restored);
	}, []);

	const refreshInFlightRef = useRef<Promise<void> | null>(null);
	const pendingRefreshRef = useRef<{ bump: boolean } | null>(null);
	const refresh = useCallback(async (bumpRevision = false) => {
		if (refreshInFlightRef.current) {
			pendingRefreshRef.current = {
				bump: (pendingRefreshRef.current?.bump ?? false) || bumpRevision,
			};
			return refreshInFlightRef.current;
		}
		const run = (async () => {
			let nextBump: boolean | null = bumpRevision;
			try {
				while (nextBump !== null) {
					const bump = nextBump;
					nextBump = null;
					try {
						const res = await fetch("/api/courses", { cache: "no-store" });
						if (res.ok) {
							const data = (await res.json()) as CoursesView;
							if (Array.isArray(data?.courses) && data.membership && typeof data.membership === "object") {
								applyView(data, bump);
							}
						}
					} catch {
						// transient failure keeps last state
					}
					if (pendingRefreshRef.current) {
						nextBump = pendingRefreshRef.current.bump;
						pendingRefreshRef.current = null;
					}
				}
			} finally {
				refreshInFlightRef.current = null;
			}
		})();
		refreshInFlightRef.current = run;
		return run;
	}, [applyView]);

	useEffect(() => {
		void refresh(false);
	}, [refresh]);

	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;

	useEffect(() => {
		if (!hub) return;
		const offEvent = hub.subscribe("courses-changed", () => {
			void refreshRef.current(true);
		});
		const offResync = hub.onResync(() => {
			void refreshRef.current(true);
		});
		return () => {
			offEvent();
			offResync();
		};
	}, [hub]);

	const mutate = useCallback(
		async (request: CourseRequest): Promise<CoursesView> => {
			const res = await fetch("/api/courses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
			});
			const body = (await res.json().catch(() => ({}))) as Partial<CoursesView> & { error?: unknown };
			if (!res.ok) {
				throw new Error(typeof body.error === "string" ? body.error : `Course request failed (${res.status})`);
			}
			const view: CoursesView = {
				courses: Array.isArray(body.courses) ? body.courses : [],
				membership: body.membership && typeof body.membership === "object" ? body.membership : {},
			};
			applyView(view, request.action !== "rescan");
			return view;
		},
		[applyView],
	);

	// "Opening a course" includes reopening the app with one restored: after
	// the first load reconciles the stored filter, rescan it once.
	const bootRescanRef = useRef(false);
	useEffect(() => {
		if (bootRescanRef.current || !loaded) return;
		bootRescanRef.current = true;
		const restored = filterRef.current;
		if (restored.kind === "course") void mutate({ action: "rescan", id: restored.courseId }).catch(() => {});
	}, [loaded, mutate]);

	const setFilter = useCallback(
		(next: CourseFilter) => {
			const prev = filterRef.current;
			const switchedToCourse =
				next.kind === "course" && (prev.kind !== "course" || prev.courseId !== next.courseId);
			filterRef.current = next;
			setFilterState(next);
			writeStoredFilter(next);
			if (switchedToCourse) {
				void mutate({ action: "rescan", id: next.courseId }).catch(() => {});
			}
		},
		[mutate],
	);

	const activeCourse = useMemo(
		() => (filter.kind === "course" ? courses.find((c) => c.id === filter.courseId) ?? null : null),
		[courses, filter],
	);

	const [attachTarget, setAttachTarget] = useState<CourseAttachTarget | null>(null);
	const attachTargetRef = useRef<CourseAttachTarget | null>(null);
	const registerAttachTarget = useCallback((target: CourseAttachTarget) => {
		attachTargetRef.current = target;
		setAttachTarget(target);
		return () => {
			if (attachTargetRef.current === target) {
				attachTargetRef.current = null;
				setAttachTarget(null);
			}
		};
	}, []);
	const getAttachTarget = useCallback(() => attachTargetRef.current, []);

	const uploadFiles = useCallback(
		async (courseId: string, files: readonly File[], chatId?: string): Promise<CourseFilesResponse> => {
			const result = await postCourseFiles(courseId, files, chatId);
			applyView({ courses: result.courses, membership: result.membership }, true);
			return result;
		},
		[applyView],
	);

	const value = useMemo<CoursesContextValue>(
		() => ({
			courses,
			membership,
			loaded,
			filter,
			activeCourse,
			activeCourseId: activeCourseIdOf(filter),
			attachTarget,
			revision,
			setFilter,
			refresh: () => refresh(false),
			mutate,
			uploadFiles,
			registerAttachTarget,
			getAttachTarget,
		}),
		[courses, membership, loaded, filter, activeCourse, attachTarget, revision, setFilter, refresh, mutate, uploadFiles, registerAttachTarget, getAttachTarget],
	);

	return <CoursesContext.Provider value={value}>{children}</CoursesContext.Provider>;
}
