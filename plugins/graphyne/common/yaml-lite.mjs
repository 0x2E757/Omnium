// Vendored YAML-subset parser (DESIGN.md D4, design-code-reviewer.md §Q3).
// Replaces the eemeli `yaml` dependency for the ONE call site Graphyne has:
// graph.mjs's parseMeta, whose contract is lenient — any throw from here maps
// to an empty graph, so a hand-edited file the subset cannot read degrades to
// `{related: []}` instead of crashing. The grammar is exactly the §Q3 spec:
// block mappings/sequences, non-nested flow collections of scalars, plain /
// single-quoted / double-quoted scalars with YAML 1.2 CORE-SCHEMA resolution,
// comments, blank lines, CRLF, one optional `---`/`...` marker pair. It THROWS
// on anchors/aliases, tags, block scalars, directives, nested flow, tab
// indentation and duplicate keys. Parity with yaml@2.9.0 is pinned by
// tests/graphyne/yaml-lite.test.mjs replaying tests/parity/fixtures/
// yaml-parse.json (value-or-throw per case; the design-accepted divergence is
// that we throw where eemeli parsed anchors/tags/block scalars/directives/
// nested flow) and yaml-roundtrip-real.json (byte round-trip of real stores).
//
// Non-obvious decision: core-schema scalar RESOLUTION is load-bearing, not
// cosmetic — `path: 123` must parse as a NUMBER so parseMeta's
// `typeof rawPath === "string"` check skips it exactly as it did under eemeli
// (graph.mts:99 in the original source). A string-only parser would silently start
// accepting numeric-looking paths that the old plugin rejected.
//
// The sibling emitter lives in graph.mjs (serializeMeta): Meta's shape is so
// small that a dedicated emitter is byte-exact by construction, so no generic
// stringifier exists here.

/** @typedef {{ indent: number, text: string }} Line */

/**
 * Parse a YAML-subset document into plain JS values (object/array/string/
 * number/boolean/null), or throw on anything outside the subset. The lenient
 * caller (parseMeta) maps every throw to an empty Meta.
 * @param {string} raw
 * @returns {unknown}
 */
export function parseYamlLite(raw) {
  const lines = splitLines(raw);
  const st = { lines, pos: 0 };

  // Optional single leading `---` (comments/blank lines may precede it —
  // splitLines already dropped them).
  if (st.pos < lines.length) {
    const first = lines[st.pos];
    if (first.indent === 0 && first.text.startsWith("%")) {
      throw new Error("YAML directives (%) are not supported by the vendored subset parser.");
    }
    if (first.indent === 0 && first.text === "---") st.pos++;
  }

  if (st.pos >= lines.length) return null; // empty / comments-only document

  const value = parseBlockNode(st, lines[st.pos].indent);

  // Optional trailing `...`; a SECOND document (`---`) or any leftover
  // content is outside the subset (eemeli also errors on multiple documents).
  if (st.pos < lines.length && lines[st.pos].indent === 0 && lines[st.pos].text === "...") {
    st.pos++;
  }
  if (st.pos < lines.length) {
    if (lines[st.pos].text === "---") {
      throw new Error("Source contains multiple documents; the vendored subset parser reads one.");
    }
    throw new Error(`Unexpected content after the document: "${lines[st.pos].text}".`);
  }
  return value;
}

/**
 * Split the source into content lines with their indent, throwing on tab
 * indentation (outside the subset; eemeli errors too). Blank and full-line
 * comment lines are DROPPED here — plain-scalar folding, the only construct
 * that would care about blank lines, is handled with its own lookahead over
 * these content lines and folds each dropped blank as a newline via the
 * `blanksBefore` count carried on the following line.
 * @param {string} raw
 * @returns {(Line & { blanksBefore: number })[]}
 */
function splitLines(raw) {
  const source = raw.replace(/^﻿/, ""); // shells sometimes prepend a BOM
  /** @type {(Line & { blanksBefore: number })[]} */
  const out = [];
  let blanks = 0;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine; // CRLF input
    const leading = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (leading.includes("\t")) {
      throw new Error("Tabs are not allowed as indentation in the vendored subset parser.");
    }
    const text = line.slice(leading.length).replace(/[ \t]+$/, "");
    if (text === "") {
      blanks++;
      continue;
    }
    if (text.startsWith("#")) continue; // full-line comment
    out.push({ indent: leading.length, text, blanksBefore: blanks });
    blanks = 0;
  }
  return out;
}

/**
 * True when `text` opens a block sequence entry (`-` alone or `- item`).
 * A tab straight after the dash is indentation in disguise — throw.
 * @param {string} text
 */
function isSeqEntry(text) {
  if (text === "-") return true;
  if (text.startsWith("-\t")) {
    throw new Error("Tabs are not allowed as indentation in the vendored subset parser.");
  }
  return text.startsWith("- ");
}

/**
 * Find the mapping key/value split in a line: the index of a `:` that is
 * followed by a space or ends the line, or -1 when the line is not a mapping
 * entry (`a:b` is a plain scalar — colon without following space).
 * @param {string} text
 * @returns {number}
 */
function keyColonIndex(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ":" && (i + 1 === text.length || text[i + 1] === " ")) return i;
  }
  return -1;
}

/**
 * Parse the block node starting at the current line, dispatching on its shape:
 * sequence entry, mapping entry, or (possibly folded) scalar document.
 * @param {{ lines: (Line & { blanksBefore: number })[], pos: number }} st
 * @param {number} indent
 * @returns {unknown}
 */
function parseBlockNode(st, indent) {
  const line = st.lines[st.pos];
  if (isSeqEntry(line.text)) return parseBlockSeq(st, indent);
  if (keyColonIndex(line.text) >= 0) return parseBlockMap(st, indent);
  return parseScalarBlock(st, indent);
}

/** True when a line at column 0 is a document marker the block loops must
 *  yield to (the driver decides whether `...` ends or `---` overflows).
 * @param {Line} line */
function isDocMarker(line) {
  return line.indent === 0 && (line.text === "---" || line.text === "...");
}

/**
 * Parse a block mapping whose keys sit at exactly `indent`. A line indented
 * DEEPER than the mapping after a completed entry means inconsistent columns
 * (eemeli: "All mapping items must start at the same column") — throw.
 * @param {{ lines: (Line & { blanksBefore: number })[], pos: number }} st
 * @param {number} indent
 * @returns {Record<string, unknown>}
 */
function parseBlockMap(st, indent) {
  /** @type {Record<string, unknown>} */
  const obj = {};
  while (st.pos < st.lines.length) {
    const line = st.lines[st.pos];
    if (isDocMarker(line)) break;
    if (line.indent < indent) break; // dedent -> parent closes us
    if (line.indent > indent) {
      throw new Error("All mapping items must start at the same column in the vendored subset parser.");
    }
    const colon = keyColonIndex(line.text);
    if (colon < 0) {
      throw new Error(`Expected a mapping key at column ${indent}, got "${line.text}".`);
    }
    const key = line.text.slice(0, colon).trimEnd();
    rejectUnsupportedScalar(key);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`Map keys must be unique; "${key}" repeats.`);
    }
    const rest = stripComment(line.text.slice(colon + 1).trim());
    st.pos++;
    obj[key] = rest === "" ? parseNestedValue(st, indent) : parseInlineValue(rest, st, indent);
  }
  return obj;
}

/**
 * The value of a `key:` (or `-`) with nothing on its own line: a nested block
 * at deeper indent, a sequence whose dashes may sit at the SAME column as the
 * parent key (YAML allows unindented sequences and hand-editors write them),
 * or null when neither follows.
 * @param {{ lines: (Line & { blanksBefore: number })[], pos: number }} st
 * @param {number} indent
 * @returns {unknown}
 */
function parseNestedValue(st, indent) {
  const next = st.lines[st.pos];
  if (!next || isDocMarker(next)) return null;
  if (next.indent > indent) return parseBlockNode(st, next.indent);
  if (next.indent === indent && isSeqEntry(next.text)) return parseBlockSeq(st, indent);
  return null;
}

/**
 * Parse a block sequence whose dashes sit at exactly `indent`. `- inline`
 * items are handled by REWRITING the line as if the dash were indentation
 * (`- path: x` becomes `path: x` two columns deeper) and recursing — that one
 * trick makes inline mappings with deeper continuation keys fall out of the
 * ordinary block-mapping parser.
 * @param {{ lines: (Line & { blanksBefore: number })[], pos: number }} st
 * @param {number} indent
 * @returns {unknown[]}
 */
function parseBlockSeq(st, indent) {
  /** @type {unknown[]} */
  const arr = [];
  while (st.pos < st.lines.length) {
    const line = st.lines[st.pos];
    if (isDocMarker(line)) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new Error("All sequence items must start at the same column in the vendored subset parser.");
    }
    if (!isSeqEntry(line.text)) break; // a sibling mapping key at this column closes the sequence
    if (line.text === "-") {
      st.pos++;
      arr.push(parseNestedValue(st, indent));
      continue;
    }
    // "- content": content starts after the dash and its run of spaces.
    let contentStart = 1;
    while (line.text[contentStart] === " ") contentStart++;
    st.lines[st.pos] = {
      ...line,
      indent: indent + contentStart,
      text: line.text.slice(contentStart),
    };
    arr.push(parseBlockNode(st, indent + contentStart));
  }
  return arr;
}

/**
 * Parse a scalar document/block: the current line's inline value, with plain
 * scalars folding deeper-indented continuation lines (`path: a` + `  b` reads
 * as "a b", exactly as eemeli folds multiline plains).
 * @param {{ lines: (Line & { blanksBefore: number })[], pos: number }} st
 * @param {number} indent
 * @returns {unknown}
 */
function parseScalarBlock(st, indent) {
  const text = stripComment(st.lines[st.pos].text);
  st.pos++;
  return parseInlineValue(text, st, indent === 0 ? -1 : indent - 1);
}

/**
 * Parse an inline value (everything after `key: ` with comments stripped).
 * `parentIndent` bounds plain-scalar folding: continuation lines must be
 * indented deeper than the construct that owns the scalar.
 * @param {string} text
 * @param {{ lines: (Line & { blanksBefore: number })[], pos: number }} st
 * @param {number} parentIndent
 * @returns {unknown}
 */
function parseInlineValue(text, st, parentIndent) {
  const c0 = text[0];
  if (c0 === '"') return parseDoubleQuoted(text);
  if (c0 === "'") return parseSingleQuoted(text);
  if (c0 === "[") return parseFlowSeq(text);
  if (c0 === "{") return parseFlowMap(text);
  rejectUnsupportedScalar(text);

  // Plain scalar. Fold deeper-indented continuation lines: one line break
  // becomes a space, n+1 breaks become n newlines (YAML line folding).
  let folded = text;
  while (st.pos < st.lines.length) {
    const next = st.lines[st.pos];
    if (isDocMarker(next) || next.indent <= parentIndent) break;
    if (keyColonIndex(next.text) >= 0 || isSeqEntry(next.text)) {
      // Structure where a continuation would be is exactly eemeli's
      // "implicit map keys need to be on a single line" family of errors.
      throw new Error(`Unexpected structured line inside a plain scalar: "${next.text}".`);
    }
    folded += (next.blanksBefore > 0 ? "\n".repeat(next.blanksBefore) : " ") + stripComment(next.text);
    st.pos++;
  }
  if (folded.includes(": ") || folded.endsWith(":")) {
    throw new Error(`Nested inline mappings are not supported: "${folded}".`);
  }
  return resolvePlainScalar(folded);
}

/**
 * Throw for scalar-position syntax the subset deliberately refuses: anchors,
 * aliases, tags, block scalars, and the reserved `@`/`` ` `` indicators. The
 * lenient parseMeta contract turns these throws into an empty Meta (the
 * design-accepted divergence from eemeli, which resolves some of them).
 * @param {string} text
 */
function rejectUnsupportedScalar(text) {
  const c0 = text[0];
  if (c0 === "&" || c0 === "*") {
    throw new Error("Anchors and aliases are not supported by the vendored subset parser.");
  }
  if (c0 === "!") {
    throw new Error("Tags are not supported by the vendored subset parser.");
  }
  if (c0 === "|" || c0 === ">") {
    throw new Error("Block scalars are not supported by the vendored subset parser.");
  }
  if (c0 === "@" || c0 === "`") {
    throw new Error(`The "${c0}" indicator is reserved in YAML and not valid plain-scalar syntax.`);
  }
}

/**
 * Strip a trailing ` # comment` (a `#` preceded by whitespace, outside any
 * quote) and trailing spaces. `a#b` keeps its hash — only whitespace-preceded
 * hashes open comments in YAML.
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') quote = "";
    } else if (quote === "'") {
      if (ch === "'") quote = text[i + 1] === "'" ? (i++, quote) : "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i).replace(/[ \t]+$/, "");
    }
  }
  return text;
}

/**
 * Parse a single-line double-quoted scalar with JSON-style escapes plus
 * `\uXXXX`. Unknown escapes and unclosed quotes throw (matching eemeli).
 * @param {string} text
 * @returns {string}
 */
function parseDoubleQuoted(text) {
  let out = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (text.slice(i + 1).trim() !== "") {
        throw new Error(`Unexpected content after the closing quote: "${text}".`);
      }
      return out;
    }
    if (ch === "\\") {
      const esc = text[i + 1];
      switch (esc) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error(`Invalid \\u escape in double-quoted scalar: "${text}".`);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          throw new Error(`Invalid escape sequence \\${esc} in double-quoted scalar.`);
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  throw new Error(`Missing closing " quote: "${text}".`);
}

/**
 * Parse a single-line single-quoted scalar; `''` is the only escape.
 * @param {string} text
 * @returns {string}
 */
function parseSingleQuoted(text) {
  let out = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      if (text.slice(i + 1).trim() !== "") {
        throw new Error(`Unexpected content after the closing quote: "${text}".`);
      }
      return out;
    }
    out += ch;
    i++;
  }
  throw new Error(`Missing closing ' quote: "${text}".`);
}

/**
 * Split single-line flow-collection content on commas, respecting quotes and
 * throwing on nested flow (outside the subset). Shared by [] and {}.
 * @param {string} inner
 * @returns {string[]}
 */
function splitFlowItems(inner) {
  /** @type {string[]} */
  const items = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote === '"') {
      if (ch === "\\") { current += ch + (inner[i + 1] ?? ""); i++; continue; }
      if (ch === '"') quote = "";
      current += ch;
    } else if (quote === "'") {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") { current += "'"; i++; } // '' stays inside the scalar
        else quote = "";
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      throw new Error("Nested flow collections are not supported by the vendored subset parser.");
    } else if (ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote !== "") throw new Error(`Unclosed ${quote} quote inside a flow collection.`);
  items.push(current.trim());
  // A trailing comma leaves one empty tail item; YAML permits it — drop it.
  if (items.length > 0 && items[items.length - 1] === "") items.pop();
  return items;
}

/**
 * One flow-position scalar: quoted or plain with core-schema resolution.
 * @param {string} item
 * @returns {unknown}
 */
function parseFlowScalar(item) {
  if (item.startsWith('"')) return parseDoubleQuoted(item);
  if (item.startsWith("'")) return parseSingleQuoted(item);
  rejectUnsupportedScalar(item);
  return resolvePlainScalar(item);
}

/**
 * Parse a single-line flow sequence of scalars: `[a, b]`, `[]`. Multiline or
 * unclosed flow throws (eemeli errors on the block/flow indent rules there).
 * @param {string} text
 * @returns {unknown[]}
 */
function parseFlowSeq(text) {
  if (!text.endsWith("]")) {
    throw new Error(`Flow sequence must open and close on one line: "${text}".`);
  }
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlowItems(inner).map(parseFlowScalar);
}

/**
 * Parse a single-line flow mapping of scalar values: `{a: b}`, `{}`.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseFlowMap(text) {
  if (!text.endsWith("}")) {
    throw new Error(`Flow mapping must open and close on one line: "${text}".`);
  }
  const inner = text.slice(1, -1).trim();
  /** @type {Record<string, unknown>} */
  const obj = {};
  if (inner === "") return obj;
  for (const item of splitFlowItems(inner)) {
    const colon = keyColonIndex(item);
    const key = colon < 0 ? item : item.slice(0, colon).trimEnd();
    const value = colon < 0 ? null : parseFlowScalar(item.slice(colon + 1).trim());
    rejectUnsupportedScalar(key);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`Map keys must be unique; "${key}" repeats.`);
    }
    obj[key] = value;
  }
  return obj;
}

// YAML 1.2 CORE-SCHEMA plain-scalar forms. Deliberately the 1.2 set: yes/no/
// on/off stay STRINGS (eemeli's default schema is core), while ~ is null and
// 0x/0o integers resolve — parity here is what keeps parseMeta's type checks
// behaving identically to the eemeli-backed plugin.
const NULL_RE = /^(?:null|Null|NULL|~)$/;
const TRUE_RE = /^(?:true|True|TRUE)$/;
const FALSE_RE = /^(?:false|False|FALSE)$/;
const INT_RE = /^[-+]?[0-9]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const OCT_RE = /^0o[0-7]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INF_RE = /^[-+]?\.(?:inf|Inf|INF)$/;
const NAN_RE = /^\.(?:nan|NaN|NAN)$/;

/**
 * Resolve a plain scalar under the YAML 1.2 core schema: null, booleans,
 * base-10/16/8 integers, floats (including .inf/.nan), else the string
 * itself. Exported for graph.mjs's Meta emitter, which quotes any scalar
 * that would NOT round-trip as a plain string.
 * @param {string} text trimmed plain-scalar text
 * @returns {unknown}
 */
export function resolvePlainScalar(text) {
  if (text === "" || NULL_RE.test(text)) return null;
  if (TRUE_RE.test(text)) return true;
  if (FALSE_RE.test(text)) return false;
  if (INT_RE.test(text)) return parseInt(text, 10);
  if (HEX_RE.test(text)) return parseInt(text.slice(2), 16);
  if (OCT_RE.test(text)) return parseInt(text.slice(2), 8);
  if (INF_RE.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (NAN_RE.test(text)) return NaN;
  if (FLOAT_RE.test(text)) return parseFloat(text);
  return text;
}
