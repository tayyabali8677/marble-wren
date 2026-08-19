/**
 * Locates the single `{ ... }` object literal that contains a given anchor
 * substring (e.g. `slug: "some-slug"`), by walking outward from the anchor
 * to find its enclosing braces. Used to extract one scholarship/university
 * entry out of a large data-array file without parsing the whole file as
 * TypeScript.
 */
export type ObjectLiteralMatch = { start: number; end: number; text: string };

export function findObjectLiteral(src: string, anchor: string): ObjectLiteralMatch | null {
  const anchorIdx = src.indexOf(anchor);
  if (anchorIdx === -1) return null;

  // Walk backward from the anchor to find the '{' that opens its object:
  // every unmatched '}' seen along the way means one more enclosing level
  // to skip before the next '{' is the real opener.
  let depth = 0;
  let start = -1;
  for (let i = anchorIdx; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;

  // Walk forward from the opener to find its matching close, respecting
  // string literals so a brace character inside a quoted value doesn't
  // throw off the depth count.
  depth = 0;
  let end = -1;
  let inString: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;

  return { start, end, text: src.slice(start, end) };
}
