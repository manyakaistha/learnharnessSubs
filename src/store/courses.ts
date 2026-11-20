import fs from "node:fs";
import path from "node:path";
import { COURSES_FILE, mkdirDataDirectory } from "../../config.ts";
import { emptyCourseState, parseCourseState } from "../core/courses.ts";
import type { CourseStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

/** Same discipline as source-organization: strict parse both ways, atomic write. */
export const courseStore: CourseStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(COURSES_FILE, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCourseState();
			throw error;
		}
		return parseCourseState(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseCourseState(state);
		mkdirDataDirectory(path.dirname(COURSES_FILE));
		ensureGraphFormat();
		writeFileAtomicSync(COURSES_FILE, JSON.stringify(valid, null, "\t") + "\n");
		removeLeftoverTemps(COURSES_FILE);
		emit("courses-changed", {});
	},
};
