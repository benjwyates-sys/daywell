#!/usr/bin/env node
// Local-first Daywell CLI: the one door an agent uses to read and write the user's own records.
// Wraps the same tool contract as the MCP server; the store does the atomic, locked (SQLite
// BEGIN IMMEDIATE) writes. No network, model, mailbox or account access.
import { existsSync, readFileSync, chmodSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createStore } from "./store.js";
import { createPreferencesStore } from "./user-preferences.js";
import { createTools } from "./tools.js";
import { operate } from "./storage-cli.js";

const usage = `Usage: daywell [--db PATH] [--read-only] COMMAND
  tools                       List tools with descriptions and read/write scope
  schema TOOL                 JSON Schema for a tool's input
  call TOOL [--input FILE]    Run a tool; JSON input from FILE or stdin; JSON result on stdout
  setup                       Check Node, create the private store, print where to point your agent (safe to repeat)
  init                        Create an empty private store if none exists (safe to repeat)
  export NEW_FILE             Write all of your data (originals included) as portable JSON; never overwrites
  backup NEW_FILE             Consistent copy of the database and preferences (NEW_FILE and NEW_FILE.preferences.sqlite); never overwrites
  restore BACKUP NEW_DB       Rebuild a new store from a backup; never overwrites
  info                        Database and preferences file locations, usage
Database: --db, else DAYWELL_DB, else ~/.daywell/daywell.sqlite. Errors are JSON on stderr, exit code 1.`;


const prefsPath = (db) => db + ".preferences.sqlite";
// Private by default: the store holds receipts and personal paperwork.
const secure = (dbPath) => { for (const f of [dbPath, prefsPath(dbPath)]) if (existsSync(f)) chmodSync(f, 0o600); };
// Consistent online copy of a companion SQLite file, published without overwriting.
async function copyNew(source, destination) {
  const stage = mkdtempSync(join(dirname(destination), ".daywell-stage-"));
  try {
    const out = join(stage, "copy"), db = new DatabaseSync(source, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout=10000"); await sqliteBackup(db, out); } finally { db.close(); }
    const check = new DatabaseSync(out);
    try { if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw Error("Backup integrity check failed"); check.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE"); } finally { check.close(); }
    chmodSync(out, 0o600);
    linkSync(out, destination);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

const fail = (message) => {
  console.error(JSON.stringify({ error: message }));
  process.exitCode = 1;
};

function parse(argv) {
  const opts = { readOnly: false, db: null, input: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--read-only") opts.readOnly = true;
    else if (a === "--db" || a === "--input") {
      if (argv[i + 1] === undefined) throw Error(`${a} needs a value`);
      opts[a === "--db" ? "db" : "input"] = argv[++i];
    } else if (a === "-h" || a === "--help") opts.rest.push("help");
    else opts.rest.push(a);
  }
  return opts;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

async function main() {
  const opts = parse(process.argv.slice(2));
  const [command, ...args] = opts.rest;
  const dbPath = resolve(opts.db || process.env.DAYWELL_DB || resolve(homedir(), ".daywell/daywell.sqlite"));
  if (!command || command === "help") return console.log(usage);

  // Contract-only commands need no database.
  const catalog = createTools(null, null);
  if (command === "tools") {
    return console.log(JSON.stringify([...catalog.values()].map(({ name, description, scope }) => ({ name, description, scope }))));
  }
  if (command === "schema") {
    const tool = catalog.get(args[0]);
    if (!tool) return fail(`Unknown tool: ${args[0] ?? ""}`);
    return console.log(JSON.stringify(zodToJsonSchema(tool.schema, { $refStrategy: "none" })));
  }
  if (command === "export") {
    // Never creates a database: an export of nothing is a mistake, not an empty archive.
    if (!existsSync(dbPath)) return fail(`No Daywell database at ${dbPath}`);
    if (!args[0]) return fail("export needs a new destination file");
    return console.log(JSON.stringify(await operate("export", dbPath, args[0])));
  }
  if (command === "setup") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 16)) return fail(`Daywell needs Node 22.16 or later; this is ${process.versions.node}`);
    const created = !existsSync(dbPath);
    createStore(dbPath).close();
    createPreferencesStore(dbPath).close();
    secure(dbPath);
    const skill = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/daywell-local/SKILL.md");
    return console.log(JSON.stringify({
      ready: true, created, database: dbPath, preferencesFile: prefsPath(dbPath), node: process.versions.node,
      agentSkill: existsSync(skill) ? skill : null,
      next: "Give your agent the skill file above (or its text) and tell it to run `daywell call get_agent_context`. This store lives on this machine; back it up with `daywell backup NEW_FILE`.",
    }));
  }
  if (command === "init") {
    const created = !existsSync(dbPath);
    createStore(dbPath).close();
    createPreferencesStore(dbPath).close();
    secure(dbPath);
    return console.log(JSON.stringify({ database: dbPath, preferencesFile: prefsPath(dbPath), created }));
  }
  if (command === "backup") {
    if (!existsSync(dbPath)) return fail(`No Daywell database at ${dbPath}`);
    if (!args[0]) return fail("backup needs a new destination file");
    const dest = resolve(args[0]);
    if (existsSync(dest) || existsSync(prefsPath(dest))) return fail("Destination must be new");
    await operate("backup", dbPath, dest);
    if (existsSync(prefsPath(dbPath))) await copyNew(prefsPath(dbPath), prefsPath(dest));
    return console.log(JSON.stringify({ written: dest, preferencesWritten: existsSync(prefsPath(dest)) ? prefsPath(dest) : null }));
  }
  if (command === "restore") {
    const [from, to] = args.map((a) => a && resolve(a));
    if (!from || !to) return fail("restore needs a backup file and a new database path");
    if (!existsSync(from)) return fail(`No backup at ${from}`);
    if (existsSync(to) || existsSync(prefsPath(to))) return fail("Destination must be new");
    await operate("restore", from, to);
    if (existsSync(prefsPath(from))) await copyNew(prefsPath(from), prefsPath(to));
    secure(to);
    return console.log(JSON.stringify({ restored: to, database: to, preferencesFile: existsSync(prefsPath(to)) ? prefsPath(to) : null }));
  }
  if (command === "info") {
    const exists = existsSync(dbPath);
    const store = exists ? createStore(dbPath) : null;
    try {
      return console.log(JSON.stringify({
        database: dbPath, exists, preferencesFile: dbPath + ".preferences.sqlite",
        usage: store?.usage() ?? null,
        note: "Back up both files; export covers records and originals, not the separate preferences file.",
      }));
    } finally { store?.close(); }
  }
  if (command !== "call") return fail(`Unknown command: ${command}\n${usage}`);

  const tool = catalog.get(args[0]);
  if (!tool) return fail(`Unknown tool: ${args[0] ?? ""}`);
  if (opts.readOnly && tool.scope === "write") return fail(`Tool ${tool.name} writes; refused in read-only mode`);
  let input;
  try {
    const text = opts.input ? readFileSync(opts.input, "utf8") : await readStdin();
    input = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    return fail(`Invalid JSON input: ${e.message}`);
  }
  const store = createStore(dbPath);
  const preferences = createPreferencesStore(dbPath);
  secure(dbPath);
  try {
    const live = createTools(store, preferences).get(tool.name);
    console.log(JSON.stringify(live.run(live.schema.parse(input), { actorId: "local-cli" })));
  } finally {
    preferences.close();
    store.close();
  }
}

try {
  await main();
} catch (e) {
  fail(e.name === "ZodError" ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` : e.message);
}
