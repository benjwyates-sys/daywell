// Explicit local-only operations. No default database path, archive extraction, or overwrite.
import { DatabaseSync, backup } from "node:sqlite";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  linkSync,
  chmodSync,
  statSync,
  fsyncSync,
  openSync,
  closeSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createStore } from "./store.js";
import { validateArchive } from "./archive-validation.js";
import { tables } from "./storage-engine.js";
export function dump(db) {
  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
  );
  return {
    format: "daywell",
    version: 1,
    schemaVersion: 1,
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, columns]) => [
        name,
        !present.has(name) &&
        ["entity_operations", "entity_history"].includes(name)
          ? []
          : db
              .prepare(
                `SELECT ${columns.join(",")} FROM ${name} ORDER BY rowid`,
              )
              .all()
              .map((row) => ({
                ...row,
                ...(name === "documents"
                  ? { bytes: Buffer.from(row.bytes).toString("base64") }
                  : {}),
              })),
      ]),
    ),
  };
}
function syncFile(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function operate(command, source, destination, confirmation) {
  if (!source) throw Error("Explicit source path required");
  source = resolve(source);
  if (["delete", "quotas", "usage"].includes(command)) {
    statSync(source);
    const store = createStore(source);
    try {
      if (command === "delete")
        return store.deleteEntity(destination, confirmation);
      if (command === "quotas")
        return store.configureQuotas(JSON.parse(destination));
      return store.usage();
    } finally {
      store.close();
    }
  }
  if (
    !["export", "import", "backup", "restore"].includes(command) ||
    !destination
  )
    throw Error(
      'Usage: storage-cli.js export|import|backup|restore SOURCE NEW_DESTINATION; delete DB ENTITY_ID "DELETE ENTITY_ID"; usage DB; quotas DB JSON',
    );
  destination = resolve(destination);
  if (source === destination) throw Error("Destination must be new");
  const stage = mkdtempSync(join(dirname(destination), ".daywell-stage-")),
    output = join(stage, "output");
  try {
    if (command === "import") {
      // JSON container has no entry paths to extract; names and IDs are never filesystem paths.
      if (statSync(source).size > 1024 * 1024 * 1024)
        throw Error("Archive exceeds 1 GiB local import limit");
      const archive = JSON.parse(readFileSync(source, "utf8"));
      validateArchive(archive);
      const store = createStore(output);
      try {
        store.importArchive(archive);
      } finally {
        store.close();
      }
    } else {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=10000");
        if (command === "export") {
          db.exec("BEGIN");
          const archive = dump(db);
          validateArchive(archive);
          writeFileSync(output, JSON.stringify(archive), {
            flag: "wx",
            mode: 0o600,
          });
          db.exec("COMMIT");
        } else {
          // SQLite online backup includes committed WAL pages in a coherent snapshot.
          await backup(db, output);
        }
      } finally {
        db.close();
      }
    }
    if (command !== "export") {
      const db = new DatabaseSync(output);
      try {
        if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
          throw Error("Backup integrity check failed");
        const version = db.prepare("PRAGMA user_version").get().user_version;
        if (version > 1) throw Error("Unsupported backup schema");
        // Old baseline backups may lack operation/history tables; retain them for a versioned upgrade on first open.
        validateArchive(dump(db));
        db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
      } finally {
        db.close();
      }
    }
    chmodSync(output, 0o600);
    syncFile(output);
    // Atomic no-clobber publication on the same filesystem, including races with another writer.
    linkSync(output, destination);
    syncFile(dirname(destination));
    return { written: destination };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    console.log(JSON.stringify(await operate(...process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
