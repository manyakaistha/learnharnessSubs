"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, Loader2Icon, PlusIcon, SettingsIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import { Hint } from "@/components/ui/hint";
import { useCourses } from "@/components/courses";
import { NewCourseDialog } from "@/components/course-dialog";

/** Sidebar-top course selector: All / No course / each course + New course… + Course panel gear. */
export function CourseSwitcher({
	onOpenPanel,
}: {
	onOpenPanel: (courseId: string) => void;
}) {
	const { courses, filter, activeCourse, setFilter } = useCourses();
	const interactions = useInteractionLayers();
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!interactions.isElementEligible(document.querySelector<HTMLElement>('[data-testid="course-switcher-menu"]'))) return;
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (triggerRef.current?.contains(target)) return;
			setMenuOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [menuOpen, interactions]);

	const triggerLabel = activeCourse
		? activeCourse.name
		: filter.kind === "none"
			? "No course"
			: "All courses";

	return (
		<>
			<div className="mx-3 mb-2 flex items-center gap-1" data-testid="course-switcher">
				<button
					ref={triggerRef}
					type="button"
					aria-label="Course"
					aria-expanded={menuOpen}
					data-testid="course-switcher-trigger"
					onClick={() => setMenuOpen((o) => !o)}
					className="flex h-7 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-md border border-border/70 bg-background px-2 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent/50"
				>
					<span className="flex min-w-0 items-center gap-1.5">
						{activeCourse?.scanning && (
							<Loader2Icon aria-hidden="true" className="size-3 shrink-0 animate-spin text-muted-foreground" />
						)}
						<span className="truncate">{triggerLabel}</span>
					</span>
					<ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
				</button>
				{activeCourse && (
					<Hint label="Course settings" side="bottom">
						<button
							type="button"
							aria-label="Course settings"
							data-testid="course-panel-button"
							onClick={() => onOpenPanel(activeCourse.id)}
							className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent hover:text-foreground"
						>
							<SettingsIcon className="size-3.5" />
						</button>
					</Hint>
				)}
			</div>

			{menuOpen && (
				<MenuShell
					anchorRef={triggerRef}
					testid="course-switcher-menu"
					preferredSide="down"
					align="left"
					onClose={() => {
						setMenuOpen(false);
						return "closed";
					}}
					menuClass="flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-1.5 text-xs shadow-xl"
				>
					<button
						type="button"
						data-testid="course-option-all"
						onClick={() => {
							setFilter({ kind: "all" });
							setMenuOpen(false);
						}}
						className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
					>
						<span>All</span>
						{filter.kind === "all" && <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />}
					</button>
					<button
						type="button"
						data-testid="course-option-none"
						onClick={() => {
							setFilter({ kind: "none" });
							setMenuOpen(false);
						}}
						className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
					>
						<span>No course</span>
						{filter.kind === "none" && <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />}
					</button>
					{courses.length > 0 && <div className="my-0.5 border-t border-border/60" aria-hidden="true" />}
					{courses.map((course) => {
						const active = filter.kind === "course" && filter.courseId === course.id;
						return (
							<button
								key={course.id}
								type="button"
								data-testid={`course-option-${course.id}`}
								onClick={() => {
									setFilter({ kind: "course", courseId: course.id });
									setMenuOpen(false);
								}}
								className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
							>
								<span className="min-w-0 flex-1 truncate">{course.name}</span>
								<span className="flex shrink-0 items-center gap-1">
									{course.scanning && <Loader2Icon aria-hidden="true" className="size-3 animate-spin text-muted-foreground" />}
									{active && <CheckIcon aria-hidden="true" className="size-3 text-muted-foreground" />}
								</span>
							</button>
						);
					})}
					<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
					<button
						type="button"
						data-testid="course-option-new"
						onClick={() => {
							setMenuOpen(false);
							setCreateOpen(true);
						}}
						className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
					>
						<PlusIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
						<span>New course…</span>
					</button>
				</MenuShell>
			)}

			<NewCourseDialog open={createOpen} onClose={() => setCreateOpen(false)} />
		</>
	);
}
