# Courses

Owner-approved design (2026-11-20). Shared spec for every courses work package.

## Model
- A **course** groups sources (chat sessions and imported files). Each source belongs to **exactly one** course, or to none ("No course").
- **One global graph.** A course graph is a read-time projection (`projectCourseGraph`, `src/core/courses.ts`). The graph ledgers are untouched. Extraction still matches against the WHOLE graph, so a fact learned in two courses is one shared node that appears in both.
- **Includes** are live, whole-course, and transitive (`courseClosure`). A cycle is rejected. VLA includes CV and DL, so the VLA scope is VLA's own sources plus all of CV's and DL's.
- Nodes and chains in scope that have no provenance in the course's own sources are **inherited**. They render dimmed, and their clusters are labelled with their course ("CV · Lecture 3"). A node with provenance in both counts as the course's own.
- Stored in `data/graph/courses.json` (`COURSES_FILE`), strict-parsed by `parseCourseState`. Mutations are operation based (`parseCourseAction`, `applyCourseAction`).

## UI (name: "Course")
- A course switcher at the top of the sidebar: **All / No course / each course**. The active course scopes the sidebar sessions list, the Home graph (or minimal home), the Practice material picker, and new teach and practice sessions, which are assigned to it on creation. The selection persists across reloads.
- A course panel with: rename, Included courses (multi-select, cycles rejected), Sources (attach or remove absolute folder paths, per-file extraction status, rescan state), and Delete.
- Delete asks: **ungroup only** (sessions and files move to No course; the knowledge stays) or **also delete the course's own sessions and files**, using the existing source deletion.
- A session can be moved to another course or to No course from the sidebar row menu.

## Course source folders
- Adding a folder extracts **every** supported file (`IMPORT_EXTENSIONS`: txt, md, markdown, rst, org, adoc, tex, pdf) through the existing extractor → auditor → merger notes pipeline, in the background, with progress in the course panel.
- File source id: `src_` + the first 12 hex characters of sha256(`"course:" + absolutePath`). Each file is assigned to the course in `membership` and recorded in `folderFiles` with the sha256 of its bytes.
- **Opening a course** (switching to it) triggers a rescan: new files, and files whose sha256 changed, are extracted again. Unchanged files are skipped. A deleted file's knowledge is kept.
- Files are placed in the existing source-organization tree under a folder named after the course folder, so the Chains source tree shows them.

## Agent scoping in a course session
- The file tools (`read`, `ls`, `grep`, `find`, `pdf-read`) may access ONLY the folders of the course and its included courses (`CourseScope.folders`). The global File Access setting is ignored in course sessions. Sessions with no course behave exactly as today.
- A system-prompt segment lists the folders, grouped as the own course and then each included course by name, and instructs the agent as follows: resolve ambiguous references (such as "week 1") to the **own course first**; use an included course's material only when the learner names that course, or when the own course has no match.
- Graph tools and the Practice picker see only the course scope, with the course's own nodes ranked first.

## Behaviour settled during implementation and review
- **Sidebar:** a course lists only its OWN sessions. Graphs, the Practice picker and the agent see own plus included courses.
- **Moving sources:** sessions move between courses from the session row menu ("Move to course"). Imported files move with the Course picker on their row in the Chains source tree.
- **Overlapping folders:** a folder may belong to only one course. Attaching a folder that equals, contains, or is inside any course's attached folder is rejected, because file identity is global per path.
- **Scan containment:** scans never follow symlinks outside the attached folder or into credential locations. Two links to the same file extract once.
- **Hidden items:** scans skip every dot-prefixed file or directory found during traversal (`.obsidian`, app settings rather than notes, is intentionally skipped), while an attached folder whose own path is hidden is scanned; uploads strip leading dots from the stored copy name (e.g. `.notes.md` → `notes.md`, rejecting empty results) so scans pick them up.
- **Rescans:** a rescan requested while a scan runs queues exactly one follow-up pass. Reopening the app with a course already active rescans it once.
- **Deleting while extracting:** "Also delete this course's sessions and files" is refused (409) while the course's folders are still extracting.
- **Course graph provenance:** a course graph (and "No course") carries only in-scope provenance, so clusters and session lists never name an out-of-scope session.
- **Layout positions:** they merge on save, so dragging nodes in a course view keeps every other node's position.

## Attachments, Extract files, exclusions (owner-approved 2026-11-20)
- **Paperclip toggle:** shown only when a course is active. It remembers the last choice per course in localStorage. The two options are "This session only" and "Add to course sources".
  - **This session only:** the server records the absolute file paths in `sessionFiles[chatId]` (`attach-session-files`). That chat's agent may read them on top of the course scope. Its prompt lists them under "Attached for this session — rank these highest". They are never extracted or shared with other sessions. Deleting the chat drops them.
  - **Add to course sources:** the files are uploaded to `POST /api/courses/files`. The server copies them into `<data>/course-files/<courseId>/`, creating that folder on first use and attaching it with `managed: true`. They are then extracted like any course-folder file. They are also granted to the current session and listed first in its prompt, the same as session-only files.
- **"Extract files…":** gains a Course picker (No course + every course), defaulting to the active course. Choosing a course uses `POST /api/courses/files`. Choosing No course keeps today's notes import unchanged.
- **Exclusions:** deleting (through source deletion) the knowledge of a file that lives in a course folder marks its `folderFiles` entry `excluded: true` instead of removing it. Scans skip excluded files. The panel lists them as "Excluded" with "Include again" (`include-file`), which clears the entry and rescans.
- **Deleting a course:** with "Ungroup only", the managed copies stay on disk and move to No course. With "Also delete sessions and files", the managed folder is deleted too. Original files are never touched.

## Threat model note
- The LearnHarness data folder (including `course-files/`) is trusted local storage. Uploads refuse a linked managed folder, and before writing they verify where each new file landed (canonical folder and inode). A local process that can rewrite the data folder *between* that check and the write could still redirect bytes. Defending against an attacker who already controls the data folder is out of scope, as it is for every other ledger in it.
- Source deletion is refused while any course-folder file is mid-extraction, across all of its chunks.
