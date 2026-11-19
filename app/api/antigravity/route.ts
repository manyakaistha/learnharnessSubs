import { antigravityResponse } from "@/src/server";

export async function GET(request: Request) {
	return antigravityResponse(request);
}

export async function POST(request: Request) {
	return antigravityResponse(request);
}
