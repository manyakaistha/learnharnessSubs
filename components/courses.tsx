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
import type { CourseFilter, CourseRequest, CourseView, CoursesView } from "@/src/core";
import { useNotifyHub } from "@/components/server-events";

export const COURSE_FILTER_STORAGE_KEY = "lh:active-course";

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

/** Resolve a chat's effective course id, preferring server membership when present. */
export function effectiveChatCourseId(
	chat: { id: string; courseId?: string | null },
	membership: Readonly<Record<string, string>>,
): string | null {
	if (Object.hasOwn(membership, chat.id)) return membership[chat.id]!;
	return chat.courseId ?? null;
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
	const cid = effectiveChatCourseId(chat, membership);
	if (filter.kind === "none") {
		if (cid === null) return true;
		return loaded && courses !== undefined && !courses.some((c) => c.id === cid);
	}
	return cid === filter.courseId;
}

export interface CoursesContextValue {
	courses: CourseView[];
	membership: Record<string, string>;
	loaded: boolean;
	filter: CourseFilter;
	activeCourse: CourseView | null;
	activeCourseId: string | null;
	revision: number;
	setFilter: (next: CourseFilter) => void;
	refresh: () => Promise<void>;
	mutate: (request: CourseRequest) => Promise<CoursesView>;
}

const DEFAULT_CONTEXT: CoursesContextValue = {
	courses: [],
	membership: {},
	loaded: false,
	filter: ALL_FILTER,
	activeCourse: null,
	activeCourseId: null,
	revision: 0,
	setFilter: () => {},
	refresh: async () => {},
	mutate: async () => ({ courses: [], membership: {} }),
};

const CoursesContext = createContext<CoursesContextValue>(DEFAULT_CONTEXT);

export function useCourses(): CoursesContextValue {
	return useContext(CoursesContext);
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

	const value = useMemo<CoursesContextValue>(
		() => ({
			courses,
			membership,
			loaded,
			filter,
			activeCourse,
			activeCourseId: activeCourseIdOf(filter),
			revision,
			setFilter,
			refresh: () => refresh(false),
			mutate,
		}),
		[courses, membership, loaded, filter, activeCourse, revision, setFilter, refresh, mutate],
	);

	return <CoursesContext.Provider value={value}>{children}</CoursesContext.Provider>;
}
