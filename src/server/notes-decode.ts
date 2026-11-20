import { IMPORT_EXTENSIONS, UNSUPPORTED_TYPE_MESSAGE } from "../../lib/notes-import-limits.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type DecodedNotes =
	| { kind: "notes"; text: string; notice?: string }
	| { kind: "refused"; error: string };

/** Decode raw bytes as UTF-8 text or page-marked PDF Markdown with scanner/OCR notice. */
export async function decodeNotesBytes(bytes: Uint8Array): Promise<DecodedNotes> {
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
		if (bytes.subarray(0, 8192).includes(0)) return { kind: "refused", error: "This file isn't plain text." };
		return { kind: "notes", text: new TextDecoder().decode(bytes) };
	}
	// pdfjs-dist rejects Node Buffer instances, so copy Buffer inputs into a plain Uint8Array.
	const pdfBytes = Buffer.isBuffer(bytes) ? new Uint8Array(bytes) : bytes;
	const pdf = await convertPdf(pdfBytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", text, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

/** A PDF becomes page-marked Markdown; any other accepted file is read as text. */
export async function readNotesFile(file: File): Promise<DecodedNotes> {
	if (!IMPORT_EXTENSIONS.test(file.name)) return { kind: "refused", error: UNSUPPORTED_TYPE_MESSAGE };
	return decodeNotesBytes(new Uint8Array(await file.arrayBuffer()));
}
