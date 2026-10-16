import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "cli.js");
// Every test uses a temporary database; the default home-directory store is never touched.
function run(args, { input, db } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...(db ? ["--db", db] : []), ...args], {
      env: { PATH: process.env.PATH, HOME: join(tmpdir(), "daywell-cli-nohome") },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}
const json = (r) => JSON.parse(r.out);
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "daywell-cli-"));
  return { dir, db: join(dir, "daywell.sqlite"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("tools and schema expose the shared tool contract as JSON Schema", async () => {
  const tools = json(await run(["tools"]));
  const names = tools.map((t) => t.name);
  for (const n of ["add_entity", "save_original", "save_record", "get_context", "list_entities", "get_agent_context"]) assert.ok(names.includes(n), n);
  assert.ok(tools.every((t) => t.description && ["read", "write"].includes(t.scope)));
  const schema = json(await run(["schema", "add_entity"]));
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.id);
  const missing = await run(["schema", "nope"]);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.err).error, /Unknown tool/);
});

test("call round trip: entity, exact original, cited record; stdin and --input file", async () => {
  const s = sandbox();
  try {
    const entity = { id: "fridge", kind: "item", name: "Kitchen fridge", details: { homeRole: "appliance" } };
    assert.equal((await run(["call", "add_entity"], { db: s.db, input: JSON.stringify(entity) })).code, 0);
    const bytes = Buffer.from("%PDF-1.4\nreceipt original");
    const doc = { entityId: "fridge", name: "receipt.pdf", base64: bytes.toString("base64"), source: { kind: "upload", reference: "test" } };
    const file = join(s.dir, "doc.json");
    writeFileSync(file, JSON.stringify(doc));
    const saved = json(await run(["call", "save_original", "--input", file], { db: s.db }));
    const back = json(await run(["call", "read_original"], { db: s.db, input: JSON.stringify({ documentId: saved.id }) }));
    assert.equal(back.base64, doc.base64);
    const record = { entityId: "fridge", idempotencyKey: "r1", kind: "purchase", summary: "Agent read a receipt", facts: {}, evidence: [{ documentId: saved.id, location: "Page 1", page: 1 }], uncertainties: ["Date smudged"] };
    assert.equal((await run(["call", "save_record"], { db: s.db, input: JSON.stringify(record) })).code, 0);
    const ctx = json(await run(["call", "get_context"], { db: s.db, input: JSON.stringify({ entityId: "fridge" }) }));
    assert.equal(ctx.documents.length, 1);
    assert.equal(ctx.records.length, 1);
    // A second process sees the same durable state.
    const list = json(await run(["call", "list_entities"], { db: s.db, input: "{}" }));
    assert.equal(list.entities.length, 1);
  } finally { s.done(); }
});

test("invalid input, unknown tool and bad JSON fail with structured errors and no writes", async () => {
  const s = sandbox();
  try {
    const bad = await run(["call", "add_entity"], { db: s.db, input: JSON.stringify({ id: "x" }) });
    assert.equal(bad.code, 1);
    assert.ok(JSON.parse(bad.err).error);
    assert.equal((await run(["call", "nope"], { db: s.db, input: "{}" })).code, 1);
    assert.equal((await run(["call", "add_entity"], { db: s.db, input: "{not json" })).code, 1);
    const list = json(await run(["call", "list_entities"], { db: s.db, input: "{}" }));
    assert.equal(list.entities.length, 0);
  } finally { s.done(); }
});

test("--read-only refuses write tools but allows reads", async () => {
  const s = sandbox();
  try {
    const entity = JSON.stringify({ id: "a", kind: "item", name: "A" });
    const refused = await run(["--read-only", "call", "add_entity"], { db: s.db, input: entity });
    assert.equal(refused.code, 1);
    assert.match(JSON.parse(refused.err).error, /read-only/);
    assert.equal((await run(["--read-only", "call", "list_entities"], { db: s.db, input: "{}" })).code, 0);
  } finally { s.done(); }
});

test("concurrent writers from separate processes lose nothing", async () => {
  const s = sandbox();
  try {
    await run(["call", "list_entities"], { db: s.db, input: "{}" });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      run(["call", "add_entity"], { db: s.db, input: JSON.stringify({ id: `e${i}`, kind: "item", name: `Item ${i}` }) })));
    assert.ok(results.every((r) => r.code === 0), results.map((r) => r.err).join());
    const list = json(await run(["call", "list_entities"], { db: s.db, input: JSON.stringify({ limit: 50 }) }));
    assert.equal(list.entities.length, 8);
  } finally { s.done(); }
});

test("export writes a portable archive to a new file, never overwrites, and info reports paths", async () => {
  const s = sandbox();
  try {
    await run(["call", "add_entity"], { db: s.db, input: JSON.stringify({ id: "a", kind: "item", name: "A" }) });
    const out = join(s.dir, "export.json");
    const exported = json(await run(["export", out], { db: s.db }));
    assert.equal(exported.written, out);
    const archive = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(archive.format, "daywell");
    assert.equal(archive.tables.entities.length, 1);
    assert.equal(statSync(out).mode & 0o077, 0);
    const again = await run(["export", out], { db: s.db });
    assert.equal(again.code, 1);
    const info = json(await run(["info"], { db: s.db }));
    assert.equal(info.database, s.db);
    assert.equal(info.preferencesFile, s.db + ".preferences.sqlite");
    assert.ok(info.usage);
    assert.ok(existsSync(s.db));
  } finally { s.done(); }
});

test("export of a missing database fails without creating it", async () => {
  const s = sandbox();
  try {
    const r = await run(["export", join(s.dir, "out.json")], { db: s.db });
    assert.equal(r.code, 1);
    assert.equal(existsSync(s.db), false);
  } finally { s.done(); }
});

test("init creates a private empty store once and is safe to repeat", async () => {
  const s = sandbox();
  try {
    const first = json(await run(["init"], { db: s.db }));
    assert.equal(first.created, true);
    assert.equal(statSync(s.db).mode & 0o077, 0);
    await run(["call", "add_entity"], { db: s.db, input: JSON.stringify({ id: "a", kind: "item", name: "A" }) });
    const again = json(await run(["init"], { db: s.db }));
    assert.equal(again.created, false);
    const list = json(await run(["call", "list_entities"], { db: s.db, input: "{}" }));
    assert.equal(list.entities.length, 1);
  } finally { s.done(); }
});

test("backup copies records and preferences to new files; restore rebuilds a new store; neither overwrites", async () => {
  const s = sandbox();
  try {
    await run(["call", "add_entity"], { db: s.db, input: JSON.stringify({ id: "a", kind: "item", name: "A" }) });
    const prefs = { expectedRevision: 0, idempotencyKey: "p1", changes: { goals: ["Keep my fridge paperwork"] }, reason: "test", userInstructionReference: "test" };
    assert.equal((await run(["call", "set_user_preferences"], { db: s.db, input: JSON.stringify(prefs) })).code, 0);
    const bak = join(s.dir, "backup.sqlite");
    const made = json(await run(["backup", bak], { db: s.db }));
    assert.equal(made.written, bak);
    assert.ok(existsSync(bak + ".preferences.sqlite"));
    assert.equal(statSync(bak).mode & 0o077, 0);
    assert.equal((await run(["backup", bak], { db: s.db })).code, 1);
    const restored = join(s.dir, "restored.sqlite");
    assert.equal((await run(["restore", bak, restored])).code, 0);
    assert.equal((await run(["restore", bak, restored])).code, 1);
    const list = json(await run(["call", "list_entities"], { db: restored, input: "{}" }));
    assert.equal(list.entities.length, 1);
    const ctx = json(await run(["call", "get_agent_context"], { db: restored, input: "{}" }));
    assert.deepEqual(ctx.userPreferences.goals, ["Keep my fridge paperwork"]);
  } finally { s.done(); }
});

test("backup of a missing database fails without creating files", async () => {
  const s = sandbox();
  try {
    const r = await run(["backup", join(s.dir, "b.sqlite")], { db: s.db });
    assert.equal(r.code, 1);
    assert.equal(existsSync(join(s.dir, "b.sqlite")), false);
    assert.equal(existsSync(s.db), false);
  } finally { s.done(); }
});
