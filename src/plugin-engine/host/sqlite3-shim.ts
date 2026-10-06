/**
 * The `sqlite3` CLI macOS ships and Raycast extensions shell out to (every
 * `@raycast/utils` `useSQL` runs `sqlite3 --json --readonly <db> <query>`),
 * reimplemented on `node:sqlite` for Linux machines without it. Covers the
 * output modes and flags extensions use — not the interactive shell or dot
 * commands. Written into the shim dir as a standalone CommonJS script (see
 * `linux-shims.ts`), so it must not import anything.
 */
export const SQLITE3_SHIM_SCRIPT = String.raw`"use strict";
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");

function fail(message) {
  process.stderr.write("Error: " + message + "\n");
  process.exit(1);
}

let mode = "list";
let separator = "|";
let header = false;
let readOnly = false;
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("-") || arg === "-") {
    positional.push(arg);
    continue;
  }
  switch (arg.replace(/^--/, "-")) {
    case "-json": mode = "json"; break;
    case "-csv": mode = "csv"; separator = ","; break;
    case "-line": mode = "line"; break;
    case "-list": mode = "list"; break;
    case "-tabs": mode = "list"; separator = "\t"; break;
    case "-readonly": readOnly = true; break;
    case "-header": case "-headers": header = true; break;
    case "-noheader": header = false; break;
    case "-separator": separator = argv[++i] ?? separator; break;
    case "-vfs": case "-nullvalue": case "-newline": i++; break;
    case "-batch": case "-bail": case "-safe": case "-nofollow": break;
    default: fail("unknown option: " + arg);
  }
}

let [file = ":memory:", ...sqlArgs] = positional;
if (file.startsWith("file:")) {
  const url = new URL(file.replace(/^file:(?!\/\/)/, "file://"));
  if (url.searchParams.get("mode") === "ro" || url.searchParams.get("immutable") === "1") readOnly = true;
  file = decodeURIComponent(url.pathname);
}
const sql = sqlArgs.length > 0 ? sqlArgs.join(";\n") : readFileSync(0, "utf8");

/** Splits on top-level semicolons, skipping quoted text and comments. */
function statements(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "\x60" || c === "[") {
      const close = c === "[" ? "]" : c;
      i = text.indexOf(close, i + 1);
      if (i === -1) break;
    } else if (c === "-" && text[i + 1] === "-") {
      i = text.indexOf("\n", i);
      if (i === -1) break;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else if (c === ";") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(s));
}

function jsonValue(value) {
  if (value === null) return "null";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString("hex"));
  return JSON.stringify(value);
}

function text(value) {
  if (value === null) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("latin1");
  return String(value);
}

function csv(value) {
  const s = text(value);
  return /[",\n\r]/.test(s) || (separator !== "," && s.includes(separator)) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

let db;
try {
  db = new DatabaseSync(file, { readOnly });
} catch (error) {
  fail(error.message);
}

const out = [];
for (const statement of statements(sql)) {
  if (statement.startsWith(".")) fail("dot commands aren't supported: " + statement.split(/\s/)[0]);
  let prepared;
  try {
    prepared = db.prepare(statement);
    prepared.setReadBigInts(true);
  } catch (error) {
    fail(error.message);
  }
  const columns = prepared.columns().map((column) => column.name);
  if (columns.length === 0) {
    try { prepared.run(); } catch (error) { fail(error.message); }
    continue;
  }
  let rows;
  try {
    rows = prepared.all();
  } catch (error) {
    fail(error.message);
  }
  if (rows.length === 0) continue;
  if (mode === "json") {
    out.push("[" + rows.map((row) => "{" + columns.map((c) => JSON.stringify(c) + ":" + jsonValue(row[c])).join(",") + "}").join(",\n") + "]\n");
  } else if (mode === "line") {
    const width = Math.max(...columns.map((c) => c.length));
    out.push(rows.map((row) => columns.map((c) => c.padStart(width) + " = " + text(row[c])).join("\n")).join("\n\n") + "\n");
  } else {
    const cell = mode === "csv" ? csv : text;
    const lines = rows.map((row) => columns.map((c) => cell(row[c])).join(separator));
    if (header) lines.unshift(columns.map((c) => (mode === "csv" ? csv(c) : c)).join(separator));
    out.push(lines.join("\n") + "\n");
  }
}
process.stdout.write(out.join(""));
`;
