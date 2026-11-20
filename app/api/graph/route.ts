import { graphView, UnknownCourseError } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
	const course = request ? new URL(request.url).searchParams.get("course") : null;
	try {
		return Response.json(graphView(course));
	} catch (error) {
		if (error instanceof UnknownCourseError) return Response.json({ error: error.message }, { status: 404 });
		return Response.json({ error: "Could not load graph." }, { status: 500 });
	}
}
