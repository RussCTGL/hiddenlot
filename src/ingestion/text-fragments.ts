import { createHash } from "node:crypto";

// Splits pasted text / message bodies into line fragments with stable IDs and
// character offsets into the original string, so every extracted value can
// be traced back to an exact span (plan P0-03).

export interface TextFragment {
  id: string; // "L<line number>", 1-based over the original text
  text: string;
  start: number; // inclusive offset in the original text
  end: number; // exclusive offset
}

export function fragmentText(text: string): TextFragment[] {
  const fragments: TextFragment[] = [];
  let offset = 0;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (content.trim() !== "") {
      fragments.push({ id: `L${i + 1}`, text: content, start: offset, end: offset + content.length });
    }
    offset += line.length + 1;
  });
  return fragments;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
