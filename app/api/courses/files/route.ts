import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";
import { MAX_IMPORT_BODY_BYTES } from "@/lib/notes-import-limits.ts";
import { addCourseFiles, CourseInputError, CoursePayloadTooLargeError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json(
			{
				error: oversized
					? "Upload request is too large. Select fewer files."
					: "Could not read the upload. It may be incomplete; please select the files again.",
			},
			{ status: oversized ? 413 : 400 },
		);
	}

	const rawCourseId = form.get("courseId");
	if (typeof rawCourseId !== "string") {
		return Response.json({ error: "Course ID must be a non-empty string." }, { status: 400 });
	}
	const rawChatId = form.get("chatId");
	if (rawChatId !== null && typeof rawChatId !== "string") {
		return Response.json({ error: "Invalid chat ID." }, { status: 400 });
	}
	const rawFiles = form.getAll("files");
	if (rawFiles.length === 0 || !rawFiles.every((entry): entry is File => entry instanceof File)) {
		return Response.json({ error: "Select at least one file." }, { status: 400 });
	}

	try {
		return Response.json(
			await addCourseFiles({
				courseId: rawCourseId,
				files: rawFiles,
				chatId: rawChatId,
			}),
		);
	} catch (error) {
		if (error instanceof CoursePayloadTooLargeError) {
			return Response.json({ error: error.message }, { status: 413 });
		}
		if (error instanceof CourseInputError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
		return Response.json({ error: "Could not save course files." }, { status: 500 });
	}
}
