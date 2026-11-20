"use client";

import { cloneElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";
import { readCourseAttachMode, useCourses, writeCourseAttachMode, type CourseAttachMode } from "@/components/courses";
import { InteractionLayerOwner, useInteractionLayer, useInteractionLayers, useOptionalInteractionLayers } from "./interaction-layers";
import { INTERACTION_LAYER_Z_BASE } from "./host-dialog";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/** Picked files → the rooted paths an editor chips (issue #285), via the
 *  desktop bridge. Same validity rule as drops: a file without a usable
 *  path is skipped, never guessed. */
export function pathsForFiles(files: Iterable<File>, resolve: (file: File) => string): { paths: string[]; skipped: number } {
	const paths: string[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const path = resolve(file);
			quoteFilePath(path);
			paths.push(path);
		} catch { skipped++; }
	}
	return { paths, skipped };
}

/** Center over the paperclip, but clear the whole visible composer, not just
 * its bottom-aligned button. Clamp horizontally and scroll above the dock. */
export function attachmentPopupPlacement(button: { left: number; right: number }, composer: { top: number }, popupWidth: number, viewport: { width: number; height: number }) {
	const edge = 8;
	const gap = 4;
	const maxWidth = Math.max(0, viewport.width - edge * 2);
	const width = Math.min(popupWidth, maxWidth);
	return {
		left: Math.max(edge, Math.min((button.left + button.right - width) / 2, viewport.width - edge - width)),
		bottom: viewport.height - composer.top + gap,
		maxWidth,
		maxHeight: Math.max(0, Math.min(viewport.height * 0.6, composer.top - gap - edge)),
	};
}

const noSubscribe = () => () => {};
/** The bridge is fixed for the window's life; the server render is always
 *  the browser case, so hydration never mismatches. */
function useDesktopPaths(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.getPathForFile), () => false);
}

/** The choice menu owns Escape with the same layer law as MenuShell, while
 * retaining its paperclip/composer-specific geometry. Mount separately so a
 * closed button remains safe in standalone/static renders. Notices are passive. */
function AttachmentPopup({ anchorRef, rootRef, open, close, children }: {
	anchorRef: RefObject<HTMLButtonElement | null>; rootRef: RefObject<HTMLDivElement | null>;
	open: boolean; close(): void; children: ReactElement<{ style?: CSSProperties }>;
}) {
	const controller = useInteractionLayers();
	const owner = controller.ownerOf(anchorRef.current);
	const layer = useInteractionLayer({ kind: "popup", enabled: open, rootRef, anchorRef, ownerId: owner?.id,
		onClose: reason => {
			close();
			if (reason === "escape" && controller.isPopupOrigin(anchorRef.current)) anchorRef.current?.focus();
			return "closed";
		},
	});
	const portal = controller.getPortalContainer(anchorRef.current, owner?.id);
	if (!portal) return null;
	return createPortal(<InteractionLayerOwner.Provider value={open ? layer.id : owner?.id ?? null}>
		{cloneElement(children, { style: { ...children.props.style, zIndex: INTERACTION_LAYER_Z_BASE + (open ? layer.order : owner?.order ?? 0) } })}
	</InteractionLayerOwner.Provider>, portal);
}

/**
 * The attach button (issue #285): the picker's twin of a file drop — files
 * stay where they are and only their quoted paths enter the draft, at the
 * caret of `editorRef` (a PathInput root). Any file type; the agent reads
 * what it can. Desktop only: a browser File has no local path, so there the
 * button explains instead (the drop zone's notice). The separate native
 * folder choice returns the directory itself, including an empty directory.
 * aria-disabled, not disabled, so the tooltip still shows.
 */
export function AttachFilesButton({
	editorRef,
	chatId,
	onStageSessionFiles,
}: {
	editorRef: React.RefObject<HTMLDivElement | null>;
	chatId?: string;
	onStageSessionFiles?: (paths: readonly string[]) => void;
}) {
	const controller = useOptionalInteractionLayers();
	const { activeCourseId, mutate: mutateCourses, uploadFiles, getAttachTarget } = useCourses();
	const pickerRef = useRef<HTMLInputElement>(null);
	const desktop = useDesktopPaths();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const choosingFolder = useRef(false);
	const [open, setOpen] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [uploading, setUploading] = useState(false);
	const [attachMode, setAttachMode] = useState<CourseAttachMode>("session");
	const [placement, setPlacement] = useState<ReturnType<typeof attachmentPopupPlacement> | null>(null);
	const positioned = placement !== null;
	const interactive = desktop || activeCourseId !== null;

	useEffect(() => {
		if (activeCourseId) setAttachMode(readCourseAttachMode(activeCourseId));
		else {
			setError("");
			setUploading(false);
		}
	}, [activeCourseId]);

	const selectAttachMode = (next: CourseAttachMode) => {
		setAttachMode(next);
		if (activeCourseId) writeCourseAttachMode(activeCourseId, next);
	};

	const resolveTarget = () => {
		const registered = getAttachTarget();
		const targetChatId = chatId ?? (registered?.kind === "chat" ? registered.chatId : undefined);
		const stageDraft = onStageSessionFiles ?? (registered?.kind === "draft" ? registered.onStageFiles : undefined);
		return { targetChatId, stageDraft };
	};

	// Like MenuShell, portal to body with viewport-capped, reanchored placement.
	// The production chat/new-session docks deliberately clip their children.
	// Keep notice focus passive; only the choice menu takes keyboard focus.
	useLayoutEffect(() => {
		if (!open && !notice && !error) { setPlacement(null); return; }
		const button = buttonRef.current;
		const popup = popupRef.current;
		if (!button || !popup) return;
		const composer = button.closest<HTMLElement>("[data-attachment-composer]") ?? button;
		const place = () => {
			setPlacement(attachmentPopupPlacement(button.getBoundingClientRect(), composer.getBoundingClientRect(),
				popup.getBoundingClientRect().width, { width: window.innerWidth, height: window.innerHeight }));
		};
		place();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
		observer?.observe(composer);
		observer?.observe(popup);
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => { observer?.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
	}, [open, notice, error]);
	useEffect(() => {
		if (open && positioned && isInteractionScopeEligible(popupRef.current, controller)) {
			(popupRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
				?? popupRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
		}
	}, [open, positioned, controller]);
	useEffect(() => {
		if (!open && !notice && !error) return;
		const dismissOutside = (event: PointerEvent) => {
			if (isInteractionScopeEligible(popupRef.current, controller) && event.target instanceof Node && !popupRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) {
				setOpen(false);
				if (!uploading) {
					setNotice("");
					setError("");
				}
			}
		};
		document.addEventListener("pointerdown", dismissOutside);
		return () => document.removeEventListener("pointerdown", dismissOutside);
	}, [open, notice, error, uploading, controller]);
	const chooseFolder = async () => {
		if (choosingFolder.current) return;
		const editor = editorRef.current;
		const choose = window.lh?.chooseAttachmentFolder;
		setOpen(false);
		setNotice("");
		setError("");
		if (!choose) { setNotice(BROWSER_NOTICE); return; }
		choosingFolder.current = true;
		try {
			const chosen = await choose();
			if (chosen === null) return; // Native cancellation leaves the draft intact.
			const path = directoryReferencePath(chosen);
			if (editor?.isConnected && editor === editorRef.current) editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: [path] }));
		} catch { setNotice("Could not choose a folder. Try again."); }
		finally { choosingFolder.current = false; }
	};
	const handlePickedFiles = async (files: File[]) => {
		if (files.length === 0) return;
		if (!activeCourseId) {
			const resolve = window.lh?.getPathForFile;
			const { paths } = resolve ? pathsForFiles(files, resolve) : { paths: [] };
			if (paths.length > 0) editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			return;
		}
		const mode = readCourseAttachMode(activeCourseId);
		const { targetChatId, stageDraft } = resolveTarget();
		if (mode === "session") {
			const resolve = window.lh?.getPathForFile;
			if (!resolve) {
				setError("");
				setNotice(BROWSER_NOTICE);
				return;
			}
			const { paths } = pathsForFiles(files, resolve);
			if (paths.length === 0) {
				setError("");
				setNotice("No local file paths were available.");
				return;
			}
			editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			if (targetChatId) {
				setError("");
				setNotice("");
				try {
					await mutateCourses({ action: "attach-session-files", chatId: targetChatId, paths });
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			} else {
				stageDraft?.(paths);
			}
			return;
		}
		setUploading(true);
		setError("");
		setNotice("Adding to course sources…");
		try {
			const res = await uploadFiles(activeCourseId, files, targetChatId);
			setNotice("");
			if (res.copied.length > 0) {
				editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: res.copied }));
				if (!targetChatId) stageDraft?.(res.copied);
			}
		} catch (err) {
			setNotice("");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setUploading(false);
		}
	};
	return (
		<div className="relative shrink-0"
			onBlur={(event) => { if (isInteractionScopeEligible(popupRef.current ?? buttonRef.current, controller) && !event.currentTarget.contains(event.relatedTarget) && !popupRef.current?.contains(event.relatedTarget)) setOpen(false); }}>
			<input
				ref={pickerRef}
				type="file"
				multiple
				hidden
				data-testid="attach-files-input"
				onChange={(e) => {
					const picked = Array.from(e.currentTarget.files ?? []);
					e.currentTarget.value = ""; // allow re-picking the same file
					void handlePickedFiles(picked);
				}}
			/>
			<Hint label={desktop ? "Attach files or a folder" : activeCourseId ? "Attach files" : BROWSER_NOTICE}>
				<button
					ref={buttonRef}
					type="button"
					aria-label="Attach files"
					aria-disabled={!interactive || uploading}
					aria-haspopup="menu"
					aria-expanded={open}
					data-testid="attach-files"
					onClick={() => {
						if (!interactive || uploading) return;
						if (activeCourseId) setAttachMode(readCourseAttachMode(activeCourseId));
						setNotice("");
						setError("");
						setOpen(!open);
					}}
					className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
				>
					{uploading ? <Loader2Icon className="size-4 animate-spin" /> : <PaperclipIcon className="size-4" />}
				</button>
			</Hint>
			{(open || notice || error) && <AttachmentPopup anchorRef={buttonRef} rootRef={popupRef} open={open} close={() => setOpen(false)}><div ref={popupRef} role={open ? "menu" : error ? "alert" : "status"}
				aria-label={open ? "Attach files or a folder" : undefined}
				data-testid="attachment-popup"
				style={{ position: "fixed", zIndex: 60, ...(placement ?? { left: 0, top: 0, visibility: "hidden" }), overflowY: "auto" }}
				className={open ? "w-max rounded-lg border bg-card p-1 shadow-lg" : "w-64 rounded-lg border bg-card p-2 text-xs text-muted-foreground shadow-lg"}
				onKeyDown={(event) => {
					const buttons = Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
					if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
				}}>
				{open ? <>
					{activeCourseId && (
						<div
							role="radiogroup"
							aria-label="Attachment mode"
							data-testid="attach-mode-toggle"
							className="mb-1 flex flex-col gap-0.5 border-b border-border/60 pb-1"
						>
							<button
								type="button"
								role="radio"
								aria-checked={attachMode === "session"}
								data-testid="attach-mode-session"
								onClick={() => selectAttachMode("session")}
								className={cn(
									"flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
									attachMode === "session" ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
								)}
							>
								<span>This session only</span>
								{attachMode === "session" && <CheckIcon aria-hidden="true" className="size-3 shrink-0" />}
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={attachMode === "course"}
								data-testid="attach-mode-course"
								onClick={() => selectAttachMode("course")}
								className={cn(
									"flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
									attachMode === "course" ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
								)}
							>
								<span>Add to course sources</span>
								{attachMode === "course" && <CheckIcon aria-hidden="true" className="size-3 shrink-0" />}
							</button>
						</div>
					)}
					<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); pickerRef.current?.click(); }}>Files</button>
					{(!activeCourseId || attachMode === "session") && (
						<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
							onClick={() => { void chooseFolder(); }}>Folder</button>
					)}
				</> : error ? (
					<div className="flex items-start justify-between gap-2">
						<span data-testid="attachment-error" className="text-destructive">{error}</span>
						<button type="button" aria-label="Dismiss attachment error" onClick={() => setError("")} className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
							<XIcon className="size-3" aria-hidden />
						</button>
					</div>
				) : notice}
			</div></AttachmentPopup>}
		</div>
	);
}
