#!/usr/bin/env node
// Statusline — the statusLine renderer (self-contained, zero-dependency).
//
// Claude Code spawns this per status refresh with the status JSON on stdin and
// reads the rendered line from stdout. It is deliberately SELF-CONTAINED (only
// node:* imports, no relative imports): the hook copies THIS file, byte for
// byte, into the plugin's persistent data dir and points settings.json there,
// so it must run standalone from that copy. It fails OPEN: any error prints
// nothing and exits 0, so a bad payload never dumps a stack trace into the bar.
//
// Shape:
//   <user> @ <folder> :: <model>
//   Context: NN% [bar] | Tokens: ↑<in> / ↓<out> (total, whole session)
//   Session: NN% [bar] | Cache: <read> (+<write>) (last prompt)
//   Updated at <now> :: Reset at <reset> (TZ) :: API time <t> ($<cost>)
//
// renderStatusline() is the PURE core (no fs/stdin/clock — takes its inputs);
// the IO shell at the bottom gathers the real inputs and prints, only when the
// file is executed directly (never when a test imports the core).

import { readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// First-occurrence deep lookup (pre-order DFS == textual order, mirrors the
// old `grep -o ... | head -1` behaviour).
/**
 * @param {any} obj
 * @param {string} key
 * @returns {any}
 */
function deepFind(obj, key) {
  if (obj && typeof obj === "object") {
    if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k of Object.keys(obj)) {
      const v = deepFind(obj[k], key);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

// --------------------------------------------------------------- colors ----
const R = "\x1b[0m";
const DIM = "\x1b[0;37m"; // labels, separators, punctuation
const BOLD = "\x1b[1;37m"; // foreground values
const MUTED = "\x1b[0;90m"; // parenthetical annotations
const USER = "\x1b[38;5;250m";
const FOLDER = "\x1b[38;5;223m";
const COST = "\x1b[38;5;38m";
const IN = "\x1b[0;36m"; // ↑ input tokens
const CACHEW = "\x1b[38;5;135m"; // cache write
// Percentage thresholds (also reused as plain colors below).
const GREEN = "\x1b[0;32m",
  YELLOW = "\x1b[0;33m",
  ORANGE = "\x1b[0;38;5;208m",
  RED = "\x1b[0;31m";

/** @param {string} code @param {string|number} s @returns {string} */
const c = (code, s) => `${code}${s}${R}`;
/** @param {number} p @returns {string} */
const pctColor = (p) => (p >= 80 ? RED : p >= 60 ? ORANGE : p >= 40 ? YELLOW : GREEN);

// -------------------------------------------------------------- helpers ----
/** @param {number} n zero-padded clock @returns {string} */
const pad0 = (n) => String(n).padStart(2, "0");
/** @param {number} n right-aligned percentage @returns {string} */
const padPct = (n) => String(n).padStart(2, " ");

/** @param {number} v @returns {string} */
function fmtTokens(v) {
  v = v || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1000) return Math.round(v / 1000) + "k";
  return String(v);
}

/** @param {number} pct @param {number} len @param {string} color @returns {string} */
function bar(pct, len, color) {
  let filled = Math.floor((pct * len) / 100);
  filled = Math.max(0, Math.min(len, filled));
  return color + "▓".repeat(filled) + "░".repeat(len - filled) + R;
}

/** @param {number} sec @returns {string} */
function fmtDuration(sec) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}

/**
 * Build the multi-line status string from already-gathered inputs. PURE: no fs,
 * stdin, or clock of its own — so it is fully unit-testable. Total: never throws
 * on a malformed payload.
 * @param {object} inputs
 * @param {any} [inputs.data] the parsed stdin JSON payload
 * @param {string} [inputs.user] the authenticated account (resolved by the shell)
 * @param {Date} [inputs.now] the current time
 * @param {string} [inputs.transcriptText] the raw transcript file contents (JSONL)
 * @returns {string}
 */
export function renderStatusline({ data = {}, user = "?", now = new Date(0), transcriptText = "" }) {
  const d = data && typeof data === "object" ? data : {};

  // ----------------------------------------------------------- parse data ----
  const model = deepFind(d, "display_name") || "";

  const dirPath = d.cwd || deepFind(d, "current_dir") || "";
  const folder = dirPath ? basename(String(dirPath)) : "?";

  const costFmt = (Number(deepFind(d, "total_cost_usd")) || 0).toFixed(2);
  const apiTime = fmtDuration(Math.floor((Number(deepFind(d, "total_api_duration_ms")) || 0) / 1000));
  const usedInt = Math.round(Number(deepFind(d, "used_percentage")) || 0);

  // Whole-session token totals: sum message.usage across the transcript. input =
  // newly-ingested tokens (input + cache writes); cache reads are excluded
  // because they repeat every turn.
  let totalIn = 0,
    totalOut = 0;
  for (const line of transcriptText.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const u = JSON.parse(line).message?.usage;
      if (u) {
        totalIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        totalOut += u.output_tokens || 0;
      }
    } catch {
      /* skip unparsable transcript line */
    }
  }

  // Cache figures reflect the last prompt only (straight from the live JSON).
  const cacheWrite = Number(deepFind(d, "cache_creation_input_tokens")) || 0;
  const cacheRd = Number(deepFind(d, "cache_read_input_tokens")) || 0;

  // 5-hour rate-limit window.
  const fiveHour = deepFind(d, "five_hour") || {};
  const fiveInt = Math.round(Number(fiveHour.used_percentage) || 0);
  const fiveReset = fiveHour.resets_at;

  // Local timezone label for the reset clock.
  const tzOff = -now.getTimezoneOffset();
  let tzStr;
  if (tzOff === 0) tzStr = "UTC";
  else {
    const a = Math.abs(tzOff),
      h = Math.floor(a / 60),
      m = a % 60;
    tzStr = `GMT${tzOff >= 0 ? "+" : "-"}${h}${m ? ":" + pad0(m) : ""}`;
  }

  // --------------------------------------------------------------- render ----
  const ctxColor = pctColor(usedInt);
  const sesColor = pctColor(fiveInt);
  const clock = `${pad0(now.getHours())}:${pad0(now.getMinutes())}:${pad0(now.getSeconds())}`;
  const SEP = ` ${c(DIM, "::")} `;

  const line1 = [c(USER, user), c(DIM, "@"), c(FOLDER, folder), c(DIM, "::"), c(BOLD, model)].join(" ");

  const line2 = [
    c(DIM, "Context:"),
    c(ctxColor, padPct(usedInt) + "%"),
    bar(usedInt, 20, ctxColor),
    c(DIM, "| Tokens:"),
    c(IN, "↑ " + fmtTokens(totalIn)),
    c(DIM, "/"),
    c(YELLOW, "↓ " + fmtTokens(totalOut)),
    c(MUTED, "(total)"),
  ].join(" ");

  const line3 = [
    c(DIM, "Session:"),
    c(sesColor, padPct(fiveInt) + "%"),
    bar(fiveInt, 20, sesColor),
    c(DIM, "| Cache:"),
    c(GREEN, fmtTokens(cacheRd)),
    `${DIM}(${CACHEW}+${fmtTokens(cacheWrite)}${DIM})${R}`,
    c(MUTED, "(last prompt)"),
  ].join(" ");

  const parts4 = [`${c(DIM, "Updated at")} ${c(BOLD, clock)}`];
  if (fiveReset) {
    const r = new Date(Number(fiveReset) * 1000);
    parts4.push(
      `${c(DIM, "Reset at")} ${c(BOLD, `${pad0(r.getHours())}:${pad0(r.getMinutes())}`)} ${c(MUTED, `(${tzStr})`)}`,
    );
  }
  parts4.push(`${c(DIM, "API time")} ${c(BOLD, apiTime)} ${DIM}(${COST}$${costFmt}${DIM})${R}`);
  const line4 = parts4.join(SEP);

  return [line1, line2, line3, line4].join("\n");
}

// ------------------------------------------------------------- IO shell ----
// fs.readFileSync(0) throws EAGAIN on a Windows pipe, so read fd 0 in a loop.
/** @returns {string} */
function readStdin() {
  const buf = Buffer.alloc(65536);
  /** @type {Buffer[]} */
  const out = [];
  let n = 0;
  while (true) {
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e && /** @type {any} */ (e).code === "EAGAIN") continue; // not ready yet — retry
      break; // EOF (or anything else) — done
    }
    if (n === 0) break;
    out.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(out).toString("utf8");
}

// The authenticated Claude account is not in the statusline JSON — read it from
// ~/.claude.json. Best-effort: any failure yields "?".
/** @returns {string} */
function loadUser() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return (cfg.oauthAccount && cfg.oauthAccount.emailAddress) || deepFind(cfg, "emailAddress") || "?";
  } catch {
    return "?";
  }
}

/** @param {any} data @returns {string} */
function loadTranscript(data) {
  try {
    const p = deepFind(data, "transcript_path");
    return p ? readFileSync(String(p), "utf8") : "";
  } catch {
    return "";
  }
}

// Run only when executed directly (node <this file>), not when a test imports
// renderStatusline — so importing the module never blocks on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let out = "";
  try {
    let data = {};
    try {
      data = JSON.parse(readStdin());
    } catch {
      /* no/!json stdin — render from defaults */
    }
    out = renderStatusline({ data, user: loadUser(), now: new Date(), transcriptText: loadTranscript(data) });
  } catch {
    out = "";
  }
  if (out) process.stdout.write(out);
  process.exit(0);
}
