"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { FolderOpenIcon, Loader2Icon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useCourses } from "@/components/courses";
import type { CourseFileState, CourseFileStatus, CourseView } from "@/src/core";

export type CourseDeleteMode = "ungroup" | "delete-sources";

function displayCourseFilePath(filePath: string, folderPath?: string): string {
	if (folderPath) {
		const trimmed = folderPath.replace(/[\\/]+$/, "");
		if (filePath.startsWith(`${trimmed}/`) || filePath.startsWith(`${trimmed}\\`)) {
			return filePath.slice(trimmed.length + 1);
		}
	}
	return filePath;
}

const FILE_STATE_LABEL: Record<CourseFileState, string> = {
	queued: "Queued",
	extracting: "Extracting…",
	extracted: "Extracted",
	failed: "Failed",
};

/** Pure confirm dialog body for deleting a course — exported for SSR/DOM tests. */
export function DeleteCourseBody({
	course,
	mode,
	onModeChange,
	busy,
	failure,
	onClose,
	onRun,
	renderFrame,
}: {
	course: Pick<CourseView, "id" | "name">;
	mode: CourseDeleteMode;
	onModeChange: (mode: CourseDeleteMode) => void;
	busy: boolean;
	failure: string;
	onClose: () => void;
	onRun: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete course"
			data-testid="delete-course-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete course?</h2>
			<p className="mt-1.5 font-mono text-sm text-foreground" data-testid="delete-course-name">
				{course.name}
			</p>
			<div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Delete course options">
				<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
					<input
						type="radio"
						name="delete-course-mode"
						value="ungroup"
						data-testid="delete-course-mode-ungroup"
						checked={mode === "ungroup"}
						disabled={busy}
						onChange={() => onModeChange("ungroup")}
						className="mt-0.5 size-4 shrink-0 accent-primary"
					/>
					<span className="min-w-0">
						<span className="block text-sm text-foreground">Ungroup only (sessions move to No course)</span>
						<span className="mt-1 block text-xs text-muted-foreground">
							Removes this course. Its sessions and imported files move to No course, and all knowledge stays in the graph.
						</span>
					</span>
				</label>
				<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
					<input
						type="radio"
						name="delete-course-mode"
						value="delete-sources"
						data-testid="delete-course-mode-delete-sources"
						checked={mode === "delete-sources"}
						disabled={busy}
						onChange={() => onModeChange("delete-sources")}
						className="mt-0.5 size-4 shrink-0 accent-primary"
					/>
					<span className="min-w-0">
						<span className="block text-sm text-foreground">Also delete this course&apos;s sessions and files</span>
						<span className="mt-1 block text-xs text-muted-foreground">
							Permanently deletes this course&apos;s own sessions, imported source records, and their unique graph contributions. Original files on disk are never changed.
						</span>
					</span>
				</label>
			</div>
			{failure && (
				<p role="alert" data-testid="course-delete-failure" className="mt-3 text-xs text-destructive">
					{failure}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="course-delete-cancel"
					disabled={busy}
					onClick={onClose}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="course-delete-confirm"
					disabled={busy}
					onClick={onRun}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : failure ? "Try again" : "Delete"}
				</button>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

export function DeleteCourseDialog({
	open,
	course,
	onDelete,
	onClose,
}: {
	open: boolean;
	course: Pick<CourseView, "id" | "name"> | null;
	onDelete: (mode: CourseDeleteMode) => Promise<void>;
	onClose: () => void;
}) {
	const [mode, setMode] = useState<CourseDeleteMode>("ungroup");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState("");

	useEffect(() => {
		if (!open) {
			setMode("ungroup");
			setBusy(false);
			setFailure("");
		}
	}, [open]);

	if (!open || !course) return null;

	const run = async () => {
		if (busy) return;
		setBusy(true);
		setFailure("");
		try {
			await onDelete(mode);
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<DeleteCourseBody
			course={course}
			mode={mode}
			onModeChange={setMode}
			busy={busy}
			failure={failure}
			onClose={onClose}
			onRun={() => void run()}
			renderFrame={(frame) => (
				<HostDialog
					open
					frame={frame}
					onClose={() => {
						if (busy) return "blocked";
						onClose();
						return "closed";
					}}
					backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				>
					{frame.props.children}
				</HostDialog>
			)}
		/>
	);
}

/** Dialog for creating a new course from the sidebar switcher. */
export function NewCourseDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { courses, mutate, setFilter } = useCourses();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) {
			setName("");
			setBusy(false);
			setError("");
		}
	}, [open]);

	if (!open) return null;

	const submit = async () => {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		setError("");
		try {
			const prevIds = new Set(courses.map((c) => c.id));
			const view = await mutate({ action: "create", name: trimmed });
			const created = view.courses.find((c) => !prevIds.has(c.id)) ?? view.courses.at(-1);
			if (created) setFilter({ kind: "course", courseId: created.id });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="New course"
			data-testid="new-course-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-foreground">New course</h2>
			<form
				className="mt-3 flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<input
					type="text"
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						setError("");
					}}
					placeholder="Course name"
					aria-label="Course name"
					data-testid="new-course-name-input"
					disabled={busy}
					className="h-8 w-full rounded-sm border border-border bg-background px-2.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
				/>
				{error && (
					<p role="alert" data-testid="new-course-error" className="text-xs text-destructive">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<button
						type="button"
						data-testid="new-course-cancel"
						disabled={busy}
						onClick={onClose}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
					>
						Cancel
					</button>
					<button
						type="submit"
						data-testid="new-course-submit"
						disabled={!name.trim() || busy}
						className="rounded-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						{busy ? "Creating…" : "Create"}
					</button>
				</div>
			</form>
		</div>
	);

	return (
		<HostDialog
			open
			frame={frame}
			onClose={() => {
				if (busy) return "blocked";
				onClose();
				return "closed";
			}}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
		>
			{frame.props.children}
		</HostDialog>
	);
}

function FileStatusRow({ file, folderPath }: { file: CourseFileStatus; folderPath?: string }) {
	const label = displayCourseFilePath(file.path, folderPath);
	return (
		<div data-testid="course-file-row" className="flex flex-col gap-0.5 py-0.5 pl-3 text-xs">
			<div className="flex items-center justify-between gap-3">
				<span title={file.path} className="min-w-0 truncate font-ui text-muted-foreground">
					{label}
				</span>
				<span
					data-testid="course-file-state"
					className={
						"flex shrink-0 items-center gap-1 font-ui text-[11px] " +
						(file.state === "failed"
							? "text-destructive"
							: file.state === "extracting"
								? "text-foreground"
								: "text-muted-foreground/80")
					}
				>
					{file.state === "extracting" && <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />}
					{FILE_STATE_LABEL[file.state]}
				</span>
			</div>
			{file.state === "failed" && file.error && (
				<p data-testid="course-file-error" className="text-[11px] text-destructive">
					{file.error}
				</p>
			)}
		</div>
	);
}

/** Pure body of the Course settings panel — exported for SSR/DOM testing. */
export function CoursePanelBody({
	course,
	allCourses,
	renameDraft,
	onRenameDraft,
	renameError,
	renameBusy,
	onRenameSubmit,
	includesError,
	includesBusy,
	onToggleInclude,
	folderInput,
	onFolderInput,
	folderError,
	folderBusy,
	onAddFolder,
	canBrowseFolder = false,
	onBrowseFolder,
	onRemoveFolder,
	rescanBusy,
	rescanError,
	onRescan,
	onOpenDelete,
	onClose,
	renderFrame,
}: {
	course: CourseView;
	allCourses: readonly CourseView[];
	renameDraft: string;
	onRenameDraft: (value: string) => void;
	renameError: string;
	renameBusy: boolean;
	onRenameSubmit: () => void;
	includesError: string;
	includesBusy: boolean;
	onToggleInclude: (targetId: string, checked: boolean) => void;
	folderInput: string;
	onFolderInput: (value: string) => void;
	folderError: string;
	folderBusy: boolean;
	onAddFolder: () => void;
	canBrowseFolder?: boolean;
	onBrowseFolder?: () => void;
	onRemoveFolder: (folderId: string) => void;
	rescanBusy: boolean;
	rescanError: string;
	onRescan: () => void;
	onOpenDelete: () => void;
	onClose: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const otherCourses = allCourses.filter((c) => c.id !== course.id);
	const folderById = new Map(course.folders.map((f) => [f.id, f]));
	const orphanFiles = course.files.filter((f) => !folderById.has(f.folderId));
	const renameDirty = renameDraft.trim() !== "" && renameDraft.trim() !== course.name;

	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Course settings"
			data-testid="course-panel-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[85vh] w-[36rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
		>
			<header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
				<h2 className="font-title text-xl tracking-tight">Course</h2>
				<button
					type="button"
					aria-label="Close course settings"
					data-testid="course-panel-close"
					onClick={onClose}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</header>

			<div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
				{/* Rename */}
				<section className="flex flex-col gap-2">
					<label htmlFor="course-rename-input" className="text-xs uppercase tracking-widest text-muted-foreground">
						Name
					</label>
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (renameDirty && !renameBusy) onRenameSubmit();
						}}
					>
						<input
							id="course-rename-input"
							type="text"
							value={renameDraft}
							onChange={(e) => onRenameDraft(e.target.value)}
							data-testid="course-rename-input"
							aria-label="Course name"
							disabled={renameBusy}
							className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-background px-2.5 font-ui text-xs text-foreground outline-none"
						/>
						<button
							type="submit"
							data-testid="course-rename-submit"
							disabled={!renameDirty || renameBusy}
							className="h-8 shrink-0 rounded-sm border border-border px-3 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
						>
							{renameBusy ? "Saving…" : "Save"}
						</button>
					</form>
					{renameError && (
						<p role="alert" data-testid="course-rename-error" className="text-xs text-destructive">
							{renameError}
						</p>
					)}
				</section>

				{/* Included courses */}
				<section className="flex flex-col gap-2 border-t border-border/60 pt-4">
					<div>
						<h3 className="text-xs uppercase tracking-widest text-muted-foreground">Included courses</h3>
						<p className="mt-0.5 text-xs text-muted-foreground/80">
							Live whole-course scope: included knowledge renders dimmed and its folders are readable in sessions.
						</p>
					</div>
					{otherCourses.length === 0 ? (
						<p className="text-xs text-muted-foreground/70">No other courses yet.</p>
					) : (
						<div className="flex flex-col gap-1.5" data-testid="course-includes-list">
							{otherCourses.map((other) => {
								const checked = course.includes.includes(other.id);
								return (
									<label
										key={other.id}
										className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border/60 px-3 py-2 text-xs transition-colors hover:bg-accent/40"
									>
										<input
											type="checkbox"
											checked={checked}
											disabled={includesBusy}
											data-testid={`course-include-${other.id}`}
											onChange={(e) => onToggleInclude(other.id, e.target.checked)}
											className="size-3.5 shrink-0 accent-primary"
										/>
										<span className="min-w-0 truncate text-foreground">{other.name}</span>
									</label>
								);
							})}
						</div>
					)}
					{includesError && (
						<p role="alert" data-testid="course-includes-error" className="text-xs text-destructive">
							{includesError}
						</p>
					)}
				</section>

				{/* Sources */}
				<section className="flex flex-col gap-2.5 border-t border-border/60 pt-4">
					<div className="flex items-center justify-between gap-2">
						<h3 className="text-xs uppercase tracking-widest text-muted-foreground">Sources</h3>
						<div className="flex items-center gap-2">
							{course.scanning && (
								<span
									data-testid="course-scanning-indicator"
									className="flex items-center gap-1 text-xs text-muted-foreground"
								>
									<Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
									Scanning…
								</span>
							)}
							<button
								type="button"
								data-testid="course-rescan"
								disabled={rescanBusy || course.scanning}
								onClick={onRescan}
								className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
							>
								<RefreshCwIcon aria-hidden="true" className={`size-3 ${rescanBusy ? "animate-spin" : ""}`} />
								Rescan
							</button>
						</div>
					</div>
					{rescanError && (
						<p role="alert" data-testid="course-rescan-error" className="text-xs text-destructive">
							{rescanError}
						</p>
					)}

					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (folderInput.trim() && !folderBusy) onAddFolder();
						}}
					>
						<input
							type="text"
							value={folderInput}
							onChange={(e) => onFolderInput(e.target.value)}
							placeholder="Absolute folder path"
							aria-label="Course folder path"
							data-testid="course-folder-input"
							disabled={folderBusy}
							className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-background px-2.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
						/>
						{canBrowseFolder && onBrowseFolder && (
							<button
								type="button"
								data-testid="course-folder-browse"
								disabled={folderBusy}
								onClick={onBrowseFolder}
								className="flex h-8 shrink-0 items-center gap-1 rounded-sm border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
							>
								<FolderOpenIcon aria-hidden="true" className="size-3.5" />
								Browse…
							</button>
						)}
						<button
							type="submit"
							data-testid="course-folder-add"
							disabled={!folderInput.trim() || folderBusy}
							className="h-8 shrink-0 rounded-sm border border-border px-2.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
						>
							{folderBusy ? "Adding…" : "Add folder"}
						</button>
					</form>
					{folderError && (
						<p role="alert" data-testid="course-folder-error" className="text-xs text-destructive">
							{folderError}
						</p>
					)}

					{course.folders.length === 0 ? (
						<p className="text-xs text-muted-foreground/70">No folders attached yet.</p>
					) : (
						<div className="flex flex-col gap-3" data-testid="course-folders-list">
							{course.folders.map((folder) => {
								const files = course.files.filter((f) => f.folderId === folder.id);
								return (
									<div key={folder.id} data-testid={`course-folder-${folder.id}`} className="flex flex-col gap-1">
										<div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/50 px-3 py-1.5 text-xs">
											<span title={folder.path} className="min-w-0 truncate font-ui text-foreground">
												{folder.path}
											</span>
											<button
												type="button"
												aria-label={`Remove ${folder.path}`}
												data-testid={`course-folder-remove-${folder.id}`}
												disabled={folderBusy}
												onClick={() => onRemoveFolder(folder.id)}
												className="shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
											>
												Remove
											</button>
										</div>
										{files.map((file) => (
											<FileStatusRow key={`${file.folderId}:${file.path}`} file={file} folderPath={folder.path} />
										))}
									</div>
								);
							})}
						</div>
					)}
					{orphanFiles.length > 0 && (
						<div className="flex flex-col gap-1">
							{orphanFiles.map((file) => (
								<FileStatusRow key={`${file.folderId}:${file.path}`} file={file} />
							))}
						</div>
					)}
				</section>

				{/* Danger zone */}
				<section className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
					<span className="text-xs text-muted-foreground">Remove this course or its sessions and files</span>
					<button
						type="button"
						data-testid="course-panel-delete"
						onClick={onOpenDelete}
						className="flex shrink-0 items-center gap-1.5 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20"
					>
						<Trash2Icon aria-hidden="true" className="size-3.5" />
						Delete course…
					</button>
				</section>
			</div>
		</div>
	);

	return renderFrame ? renderFrame(frame) : frame;
}

export function CoursePanelDialog({
	courseId,
	open,
	onClose,
	onDeletedCourse,
}: {
	courseId: string | null;
	open: boolean;
	onClose: () => void;
	onDeletedCourse?: (mode: CourseDeleteMode, ownSourceIds: string[]) => void;
}) {
	const { courses, loaded, mutate } = useCourses();
	const course = courseId ? courses.find((c) => c.id === courseId) ?? null : null;

	const [renameDraft, setRenameDraft] = useState("");
	const [renameError, setRenameError] = useState("");
	const [renameBusy, setRenameBusy] = useState(false);

	const [includesError, setIncludesError] = useState("");
	const [includesBusy, setIncludesBusy] = useState(false);

	const [folderInput, setFolderInput] = useState("");
	const [folderError, setFolderError] = useState("");
	const [folderBusy, setFolderBusy] = useState(false);

	const [rescanBusy, setRescanBusy] = useState(false);
	const [rescanError, setRescanError] = useState("");

	const [deleteOpen, setDeleteOpen] = useState(false);

	useEffect(() => {
		if (!open || !course) return;
		setRenameDraft(course.name);
		setRenameError("");
		setIncludesError("");
		setFolderError("");
		setRescanError("");
	}, [open, course?.id, course?.name]);

	useEffect(() => {
		if (!open) setDeleteOpen(false);
	}, [open]);

	useEffect(() => {
		if (open && loaded && !course) onClose();
	}, [open, loaded, course, onClose]);

	if (!open || !course) return null;

	const handleRename = async () => {
		const trimmed = renameDraft.trim();
		if (!trimmed || renameBusy) return;
		setRenameBusy(true);
		setRenameError("");
		try {
			await mutate({ action: "rename", id: course.id, name: trimmed });
		} catch (err) {
			setRenameError(err instanceof Error ? err.message : String(err));
		} finally {
			setRenameBusy(false);
		}
	};

	const handleToggleInclude = async (targetId: string, checked: boolean) => {
		if (includesBusy) return;
		setIncludesBusy(true);
		setIncludesError("");
		const nextIncludes = checked
			? [...new Set([...course.includes, targetId])]
			: course.includes.filter((id) => id !== targetId);
		try {
			await mutate({ action: "set-includes", id: course.id, includes: nextIncludes });
		} catch (err) {
			setIncludesError(err instanceof Error ? err.message : String(err));
		} finally {
			setIncludesBusy(false);
		}
	};

	const submitFolderPath = async (rawPath: string) => {
		const trimmed = rawPath.trim();
		if (!trimmed || folderBusy) return;
		setFolderBusy(true);
		setFolderError("");
		try {
			await mutate({ action: "add-folder", id: course.id, path: trimmed });
			setFolderInput("");
		} catch (err) {
			setFolderError(err instanceof Error ? err.message : String(err));
		} finally {
			setFolderBusy(false);
		}
	};

	const handleBrowseFolder = async () => {
		const choose = typeof window !== "undefined" ? window.lh?.chooseAttachmentFolder : undefined;
		if (!choose || folderBusy) return;
		try {
			const picked = await choose();
			if (picked) await submitFolderPath(picked);
		} catch (err) {
			setFolderError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleRemoveFolder = async (folderId: string) => {
		if (folderBusy) return;
		setFolderBusy(true);
		setFolderError("");
		try {
			await mutate({ action: "remove-folder", id: course.id, folderId });
		} catch (err) {
			setFolderError(err instanceof Error ? err.message : String(err));
		} finally {
			setFolderBusy(false);
		}
	};

	const handleRescan = async () => {
		if (rescanBusy) return;
		setRescanBusy(true);
		setRescanError("");
		try {
			await mutate({ action: "rescan", id: course.id });
		} catch (err) {
			setRescanError(err instanceof Error ? err.message : String(err));
		} finally {
			setRescanBusy(false);
		}
	};

	const handleDelete = async (mode: CourseDeleteMode) => {
		const ownIds = course.ownSourceIds;
		await mutate({ action: "delete", id: course.id, mode });
		setDeleteOpen(false);
		onClose();
		if (mode === "delete-sources") {
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: 0 } }));
		}
		onDeletedCourse?.(mode, ownIds);
	};

	const canBrowseFolder = typeof window !== "undefined" && typeof window.lh?.chooseAttachmentFolder === "function";

	return (
		<>
			<CoursePanelBody
				course={course}
				allCourses={courses}
				renameDraft={renameDraft}
				onRenameDraft={(v) => {
					setRenameDraft(v);
					setRenameError("");
				}}
				renameError={renameError}
				renameBusy={renameBusy}
				onRenameSubmit={() => void handleRename()}
				includesError={includesError}
				includesBusy={includesBusy}
				onToggleInclude={(id, checked) => void handleToggleInclude(id, checked)}
				folderInput={folderInput}
				onFolderInput={(v) => {
					setFolderInput(v);
					setFolderError("");
				}}
				folderError={folderError}
				folderBusy={folderBusy}
				onAddFolder={() => void submitFolderPath(folderInput)}
				canBrowseFolder={canBrowseFolder}
				onBrowseFolder={() => void handleBrowseFolder()}
				onRemoveFolder={(folderId) => void handleRemoveFolder(folderId)}
				rescanBusy={rescanBusy}
				rescanError={rescanError}
				onRescan={() => void handleRescan()}
				onOpenDelete={() => setDeleteOpen(true)}
				onClose={onClose}
				renderFrame={(frame) => (
					<HostDialog
						open
						frame={frame}
						onClose={() => {
							onClose();
							return "closed";
						}}
						backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
					>
						{frame.props.children}
					</HostDialog>
				)}
			/>
			<DeleteCourseDialog
				open={deleteOpen}
				course={course}
				onDelete={handleDelete}
				onClose={() => setDeleteOpen(false)}
			/>
		</>
	);
}
