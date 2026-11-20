import { CourseInputError, coursesView, mutateCourses, readCourseRequest, SourceDeletionError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return Response.json(coursesView());
	} catch {
		return Response.json({ error: "Could not read courses." }, { status: 500 });
	}
}

export async function POST(request: Request) {
	try {
		return Response.json(mutateCourses(await readCourseRequest(request)));
	} catch (error) {
		if (error instanceof CourseInputError) return Response.json({ error: error.message }, { status: 400 });
		if (error instanceof SourceDeletionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		return Response.json({ error: "Could not save courses." }, { status: 500 });
	}
}
