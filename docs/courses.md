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
