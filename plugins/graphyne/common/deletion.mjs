// Pure-deletion detection for the refactor gate. The delete-only refactor grant
// (graphyne_refactor) opens a window where the TDD gate admits an edit ONLY when it
// is a pure deletion — no line is added or modified, some are removed. This is the
// one structural change a behavior addition cannot fake, so admitting it can never
// smuggle new untested code past the gate.
//
// "Pure deletion" is judged at WHOLE-LINE, FULL-FILE granularity: reconstruct the
// post-edit content from the tool input, then check that its lines are a
// subsequence of the current file's lines (every kept line in order, none added or
// altered). A within-line tweak (e.g. `a + b` -> `a`) changes a line rather than
// removing it, so it is NOT a deletion and must go through the normal red-first gate.
//
// Reconstruction mirrors Claude Code's edit semantics; when it cannot reproduce the
// result confidently (old_string absent, non-unique without replace_all, missing
// fields, an unsupported tool) it returns null and the caller treats the edit as a
// non-deletion — conservative: a misread can only DENY the grant, never widen it.
//
// EOL handling: the on-disk file may be CRLF while the Edit tool delivers
// old_string/new_string with LF newlines, so reconstruction and the subsequence check
// run on LF-normalized strings (\r stripped on every side). This only affects the
// comparison used to CLASSIFY the edit; the actual file write is the Edit tool's job
// and keeps the file's real line endings.

/** @typedef {{ old_string: string, new_string: string, replace_all?: boolean }} EditOp */

/**
 * Drop carriage returns so CRLF and LF content compare equal.
 * @param {string} s
 * @returns {string}
 */
function stripCR(s) {
  return s.replace(/\r/g, "");
}

/**
 * Whether `next`'s lines are a subsequence of `prev`'s lines (whole lines removed,
 * none added or modified). Equal inputs are a (degenerate) subsequence — callers
 * exclude the no-op case separately.
 * @param {string} next
 * @param {string} prev
 * @returns {boolean}
 */
function isLineSubsequence(next, prev) {
  const a = next.split("\n");
  const b = prev.split("\n");
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (a[i] === b[j]) i++;
  }
  return i === a.length;
}

/**
 * Apply one Edit operation to `text`, returning the result or null if it cannot be
 * reproduced (old_string absent, or non-unique without replace_all — which the real
 * Edit tool rejects too). An empty old_string is unsupported (null).
 * @param {string} text
 * @param {EditOp} op
 * @returns {string | null}
 */
function applyOne(text, op) {
  const { old_string: oldStr, new_string: newStr, replace_all: all } = op;
  if (typeof oldStr !== "string" || typeof newStr !== "string" || oldStr === "") return null;
  if (all) {
    if (!text.includes(oldStr)) return null;
    return text.split(oldStr).join(newStr);
  }
  const first = text.indexOf(oldStr);
  if (first < 0) return null;
  if (text.indexOf(oldStr, first + oldStr.length) >= 0) return null; // non-unique: harness errors
  return text.slice(0, first) + newStr + text.slice(first + oldStr.length);
}

/**
 * @param {unknown} v
 * @returns {EditOp | null}
 */
function asEditOp(v) {
  if (!v || typeof v !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return null;
  return { old_string: stripCR(o.old_string), new_string: stripCR(o.new_string), replace_all: o.replace_all === true };
}

/**
 * Reconstruct the post-edit file content for a given edit tool, or null if it can't
 * be reproduced confidently.
 * @param {string} current
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function reconstruct(current, toolName, input) {
  if (toolName === "Write") {
    return typeof input.content === "string" ? stripCR(input.content) : null;
  }
  if (toolName === "Edit") {
    const op = asEditOp(input);
    return op ? applyOne(current, op) : null;
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    let text = current;
    for (const raw of input.edits) {
      const op = asEditOp(raw);
      if (!op) return null;
      const next = applyOne(text, op);
      if (next === null) return null;
      text = next;
    }
    return text;
  }
  return null; // unsupported tool (NotebookEdit, etc.)
}

/**
 * Whether the proposed edit to a file (currently `current`) is a pure deletion: it
 * changes the file, and the result's lines are a subsequence of the current file's
 * lines. Anything we can't reconstruct, a no-op, or any add/modify yields false.
 * @param {string} current
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @returns {boolean}
 */
export function isPureDeletion(current, toolName, toolInput) {
  const cur = stripCR(current);
  const next = reconstruct(cur, toolName, toolInput);
  if (next === null) return false;
  if (next === cur) return false; // a no-op is not a deletion
  return isLineSubsequence(next, cur);
}
