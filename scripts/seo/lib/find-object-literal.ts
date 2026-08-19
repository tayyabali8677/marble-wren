/**
 * Locates the single `{ ... }` object literal that contains a given anchor
 * substring (e.g. `slug: "some-slug"`), by walking outward from the anchor
 * to find its enclosing braces. Used to extract one scholarship/university
 * entry out of a large data-array file without parsing the whole file as
 * TypeScript.
 *
 * Known limitation: `${...}` template-literal interpolation is not handled
 * specially — a `{` or `}` inside a `${...}` expression is treated as plain
 * template-string text (not real code), which is out of scope for this fix.
 */
export type ObjectLiteralMatch = { start: number; end: number; text: string };

/**
 * Classifies every character of `src` as either "real code" or not (inside a
 * string literal or a comment), and returns the set of indices where a brace
 * character (`{` or `}`) occurs in real code. Both the backward scan (to
 * find the opening brace) and the forward scan (to find the matching
 * closing brace) rely on this single classification pass, so they share the
 * same blind spots by construction instead of drifting apart.
 */
function findRealCodeBraces(src: string): Map<number, "{" | "}"> {
  const braces = new Map<number, "{" | "}">();
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    // Not currently inside a string or comment.
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "{" || ch === "}") {
      braces.set(i, ch);
    }
  }

  return braces;
}

export function findObjectLiteral(src: string, anchor: string): ObjectLiteralMatch | null {
  const anchorIdx = src.indexOf(anchor);
  if (anchorIdx === -1) return null;

  // An anchor that isn't unique in the source makes the match untrustworthy:
  // we can't be sure which occurrence's enclosing object we're isolating.
  if (src.indexOf(anchor, anchorIdx + 1) !== -1) return null;

  const braces = findRealCodeBraces(src);

  // Walk backward from the anchor to find the '{' that opens its object:
  // every unmatched '}' seen along the way means one more enclosing level
  // to skip before the next '{' is the real opener. Only braces classified
  // as "real code" (not inside a string or comment) are considered.
  let depth = 0;
  let start = -1;
  for (let i = anchorIdx; i >= 0; i--) {
    const brace = braces.get(i);
    if (brace === "}") {
      depth++;
    } else if (brace === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;

  // Walk forward from the opener to find its matching close, again only
  // considering real-code braces.
  depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const brace = braces.get(i);
    if (brace === "{") {
      depth++;
    } else if (brace === "}") {
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
