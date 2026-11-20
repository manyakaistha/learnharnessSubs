"use client";

import { useEffect, useRef, useState } from "react";
import { FileSymlinkIcon, XIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { readCourseAttachMode, useCourses } from "@/components/courses";

export const BROWSER_NOTICE = "Local file paths can only be attached in the desktop app. You can paste a full path instead.";

/** The content area only: the sidebar is deliberately outside this zone.
 * Existing files stay where they are; only quoted path strings enter drafts
 * (or copy to course sources when a course is active in that mode). */
export function FilePathDropZone({ children, className, onContentRoot }: {
	children: React.ReactNode;
	className?: string;
	onContentRoot?: (element: HTMLElement | null) => void;
}) {
	const { activeCourseId, mutate: mutateCourses, uploadFiles, getAttachTarget } = useCourses();
	const root = useRef<HTMLElement>(null);
	useEffect(() => {
		onContentRoot?.(root.current);
		return () => { onContentRoot?.(null); };
	}, [onContentRoot]);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [notice, setNotice] = useState("");
	const [noticeError, setNoticeError] = useState(false);
	const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
	const clearDrag = () => { depth.current = 0; setDragging(false); };
	useEffect(() => {
		// The sidebar remains a non-target, but dropping a file there must not
		// navigate the app away. No indicator or attachment is produced there.
		const preventOutsideNavigation = (event: DragEvent) => {
			if (Array.from(event.dataTransfer?.types ?? []).includes("Files")
				&& event.target instanceof Node && !root.current?.contains(event.target)) event.preventDefault();
		};
		window.addEventListener("dragover", preventOutsideNavigation);
		window.addEventListener("drop", preventOutsideNavigation);
		return () => {
			window.removeEventListener("dragover", preventOutsideNavigation);
			window.removeEventListener("drop", preventOutsideNavigation);
		};
	}, []);
	return (
		<main
			ref={root}
			className={className}
			data-testid="file-path-drop-zone"
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				depth.current++;
				setDragging(true);
				setNotice("");
				setNoticeError(false);
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDragging(false);
			}}
			onDragEnd={clearDrag}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation();
				clearDrag();
				const entries = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
				const allFiles = Array.from(event.dataTransfer.files);
				const focused = document.activeElement?.closest<HTMLElement>("[data-file-path-input]");
				const focusedInZone = Boolean(focused && event.currentTarget.contains(focused));
				const insertPaths = (targetPaths: string[]): boolean => {
					if (focusedInZone && focused?.isConnected) {
						focused.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: targetPaths }));
						return true;
					}
					return appendToPrimaryInput(targetPaths.map(quoteFilePath).join(" "));
				};

				const mode = activeCourseId ? readCourseAttachMode(activeCourseId) : "session";
				if (activeCourseId && mode === "course") {
					const filesToUpload = allFiles.filter((_, index) => {
						try { return entries[index]?.webkitGetAsEntry?.()?.isDirectory !== true; }
						catch { return true; }
					});
					if (filesToUpload.length === 0) {
						setNoticeError(false);
						setNotice("Only files can be added to course sources. Attach folders in Course settings.");
						return;
					}
					const target = getAttachTarget();
					const chatId = target?.kind === "chat" ? target.chatId : undefined;
					setNoticeError(false);
					setNotice("Adding to course sources…");
					void uploadFiles(activeCourseId, filesToUpload, chatId)
						.then((res) => {
							if (res.copied.length > 0) {
								if (!insertPaths(res.copied)) {
									setNoticeError(false);
									setNotice("Open a chat to attach file paths.");
									return;
								}
								if (target?.kind === "draft") target.onStageFiles(res.copied);
							}
							setNoticeError(false);
							setNotice(filesToUpload.length < allFiles.length ? "Folders were skipped. Attach folders in Course settings." : "");
						})
						.catch((err: unknown) => {
							setNoticeError(true);
							setNotice(err instanceof Error ? err.message : String(err));
						});
					return;
				}

				const resolve = window.lh?.getPathForFile;
				if (!resolve) { setNoticeError(false); setNotice(BROWSER_NOTICE); return; }
				// Inspect only the dropped item's type, never traverse its entries.
				// Positively known directories get a durable trailing separator.
				const paths: string[] = [];
				const filePaths: string[] = [];
				let skipped = 0;
				for (const [index, file] of allFiles.entries()) {
					try {
						let directory = false;
						try { directory = entries[index]?.webkitGetAsEntry?.()?.isDirectory === true; }
						catch { /* Unknown type stays unmarked, not guessed. */ }
						const original = resolve(file);
						const path = directory ? directoryReferencePath(original) : original;
						quoteFilePath(path); // Same rooted-path validity rule as typed chips.
						paths.push(path);
						if (!directory) filePaths.push(path);
					} catch { skipped++; }
				}
				if (paths.length === 0) {
					setNoticeError(false);
					setNotice("No local file paths were available. Drop existing files or folders from your computer.");
					return;
				}
				if (!insertPaths(paths)) {
					setNoticeError(false);
					setNotice("Open a chat to attach file paths.");
					return;
				}
				setNoticeError(false);
				setNotice(skipped ? "Some dropped items had no available file path." : "");
				if (activeCourseId && filePaths.length > 0) {
					const target = getAttachTarget();
					if (target?.kind === "chat") {
						void mutateCourses({ action: "attach-session-files", chatId: target.chatId, paths: filePaths })
							.catch((err: unknown) => {
								setNoticeError(true);
								setNotice(err instanceof Error ? err.message : String(err));
							});
					} else if (target?.kind === "draft") {
						target.onStageFiles(filePaths);
					}
				}
			}}
		>
			{children}
			{dragging && (
				<div data-testid="file-path-drop-indicator" className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 p-6 text-center backdrop-blur-sm">
					<div className="flex max-w-md flex-col items-center gap-3">
						<FileSymlinkIcon className="size-8 text-primary" aria-hidden />
						<span className="font-ui text-sm">
							{activeCourseId && readCourseAttachMode(activeCourseId) === "course"
								? "Drop to add to course sources"
								: window.lh?.getPathForFile
									? "Drop to attach file paths"
									: BROWSER_NOTICE}
						</span>
					</div>
				</div>
			)}
			{notice && <div role={noticeError ? "alert" : "status"} className="absolute bottom-2 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border bg-card px-3 py-2 font-ui text-xs shadow-sm">
				<span className={noticeError ? "text-destructive" : undefined}>{notice}</span>
				<button type="button" aria-label="Dismiss attachment notice" onClick={() => { setNotice(""); setNoticeError(false); }} className="shrink-0 rounded-sm p-1 hover:bg-accent"><XIcon className="size-3" aria-hidden /></button>
			</div>}
		</main>
	);
}
