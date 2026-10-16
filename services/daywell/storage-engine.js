import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const pageSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const tables = {
  entities: ["id", "value"],
  documents: ["id", "entity_id", "hash", "value", "bytes"],
  records: ["id", "entity_id", "request_key", "value"],
  entity_history: ["entity_id", "value"],
  entity_operations: ["request_key", "input", "result"],
};
export const defaults = {
  originalBytes: 512 * 1024 * 1024,
  metadataBytes: 64 * 1024 * 1024,
  rows: 100000,
};
export const quotaSchema = z
  .object(
    Object.fromEntries(
      Object.keys(defaults).map((k) => [
        k,
        z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      ]),
    ),
  )
  .strict();
export function initialize(db, quotas = defaults) {
  db.exec(
    "PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
  );
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1)
      throw Error(
        "Unsupported database schema; use a compatible Daywell version",
      );
    if (!version) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL, bytes BLOB NOT NULL, UNIQUE(entity_id,hash));
        CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entity_operations(request_key TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entity_history(entity_id TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE storage_state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, cursor_key TEXT NOT NULL, quotas TEXT NOT NULL);
        CREATE TABLE mutation_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL);
        CREATE UNIQUE INDEX record_successor ON records(json_extract(value,'$.input.supersedes')) WHERE json_extract(value,'$.input.supersedes') IS NOT NULL;
        CREATE INDEX documents_entity ON documents(entity_id);
        CREATE INDEX records_entity ON records(entity_id);
        CREATE INDEX history_entity ON entity_history(entity_id);
      `);
      db.prepare("INSERT INTO storage_state VALUES(1,0,?,?)").run(
        randomBytes(32).toString("hex"),
        JSON.stringify(quotaSchema.parse(quotas)),
      );
      for (const table of ["documents", "records", "entity_history"])
        db.exec(
          `CREATE TRIGGER ${table}_parent BEFORE INSERT ON ${table} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM entities WHERE id=NEW.entity_id) THEN RAISE(ABORT,'Entity reference missing') END; END;`,
        );
      db.exec(`CREATE TRIGGER record_references BEFORE INSERT ON records BEGIN
        SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.value,'$.input.evidence') e WHERE NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=json_extract(e.value,'$.documentId') AND d.entity_id=NEW.entity_id)) THEN RAISE(ABORT,'Evidence reference missing') END;
        SELECT CASE WHEN json_extract(NEW.value,'$.input.supersedes') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE id=json_extract(NEW.value,'$.input.supersedes') AND entity_id=NEW.entity_id) THEN RAISE(ABORT,'Correction reference missing') END;
      END;
      PRAGMA user_version=1;`);
    }
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw Error("SQLite integrity check failed");
    for (const table of ["documents", "records", "entity_history"])
      if (
        db
          .prepare(
            `SELECT 1 FROM ${table} t LEFT JOIN entities e ON e.id=t.entity_id WHERE e.id IS NULL LIMIT 1`,
          )
          .get()
      )
        throw Error("Existing orphan reference; upgrade rolled back");
    if (
      db
        .prepare(
          `SELECT 1 FROM records r, json_each(r.value,'$.input.evidence') e WHERE NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=json_extract(e.value,'$.documentId') AND d.entity_id=r.entity_id) LIMIT 1`,
        )
        .get()
    )
      throw Error("Existing invalid evidence; upgrade rolled back");
    if (
      db
        .prepare(
          `SELECT 1 FROM records r WHERE json_extract(r.value,'$.input.supersedes') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records old WHERE old.id=json_extract(r.value,'$.input.supersedes') AND old.entity_id=r.entity_id AND old.rowid<r.rowid) LIMIT 1`,
        )
        .get()
    )
      throw Error("Existing invalid correction chain; upgrade rolled back");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function usage(db) {
  let metadataBytes = 0,
    rows = 0;
  for (const [table, columns] of Object.entries(tables)) {
    const sizes = columns
      .filter((c) => c !== "bytes")
      .map((c) => `length(CAST(${c} AS BLOB))`)
      .join("+");
    const r = db
      .prepare(
        `SELECT count(*) AS n, coalesce(sum(${sizes}),0) AS bytes FROM ${table}`,
      )
      .get();
    metadataBytes += r.bytes;
    rows += r.n;
  }
  return {
    originalBytes: db
      .prepare("SELECT coalesce(sum(length(bytes)),0) AS n FROM documents")
      .get().n,
    metadataBytes,
    rows,
  };
}
export function enforceQuotas(db) {
  const limits = JSON.parse(
      db.prepare("SELECT quotas FROM storage_state").get().quotas,
    ),
    used = usage(db);
  for (const key of Object.keys(limits))
    if (used[key] > limits[key])
      throw Error(
        `Storage quota exceeded: ${key}; export/delete data or deliberately raise the persisted quota`,
      );
}
export function pager(db) {
  const state = () => db.prepare("SELECT * FROM storage_state").get();
  function signature(body, key) {
    return createHmac("sha256", key).update(body).digest("base64url");
  }
  function decode(cursor, scope, s) {
    try {
      const [body, mac, ...rest] = cursor.split(".");
      const expected = signature(body, s.cursor_key);
      if (
        rest.length ||
        !mac ||
        mac.length !== expected.length ||
        !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
      )
        throw Error();
      const v = JSON.parse(Buffer.from(body, "base64url").toString());
      if (
        v.scope !== scope ||
        !Array.isArray(v.positions) ||
        v.positions.some((n) => !Number.isSafeInteger(n) || n < 0)
      )
        throw Error();
      if (v.generation !== s.generation)
        throw Error(
          "STALE_CURSOR: data changed; discard accumulated pages and restart",
        );
      return v.positions;
    } catch (e) {
      if (e.message.startsWith("STALE_CURSOR")) throw e;
      throw Error("Invalid cursor for this read");
    }
  }
  function encode(scope, s, positions) {
    const body = Buffer.from(
      JSON.stringify({ scope, generation: s.generation, positions }),
    ).toString("base64url");
    return body + "." + signature(body, s.cursor_key);
  }
  const pages = (scope, input, collections, base = {}) => {
    const { limit, cursor } = pageSchema.parse(input),
      s = state();
    const positions = cursor
      ? decode(cursor, scope, s)
      : collections.map(() => 0);
    if (positions.length !== collections.length) throw Error("Invalid cursor");
    if (
      base.entity &&
      Buffer.byteLength(JSON.stringify(base.entity)) > 256 * 1024
    ) {
      const position = db
        .prepare("SELECT rowid AS n FROM entities WHERE id=?")
        .get(base.entity.id).n;
      const e = base.entity;
      base = {
        ...base,
        entity: {
          metadataCursor: encode("value:entities:" + position, s, [0]),
          entityDefaults: {
            revision: e.revision,
            personalPhotoId: e.personalPhotoId,
            representativePhoto: e.representativePhoto,
          },
        },
      };
    }
    const baseSize = Buffer.byteLength(JSON.stringify(base));
    if (baseSize > 256 * 1024)
      throw Error("Legacy entity exceeds page limit; use local export");
    const result = { ...base };
    let more = false,
      budget = 512 * 1024 - baseSize - 4096;
    const pageCapacity = budget;
    collections.forEach(
      ({ name, table, entityId, normalize = (v) => v }, i) => {
        const where = entityId === undefined ? "" : " AND entity_id=?";
        const args =
          entityId === undefined
            ? [positions[i], limit + 1]
            : [positions[i], entityId, limit + 1];
        const found = db
          .prepare(
            `SELECT rowid AS position, length(CAST(value AS BLOB)) AS size FROM ${table} WHERE rowid>?${where} ORDER BY rowid LIMIT ?`,
          )
          .all(...args);
        result[name] = [];
        for (const row of found) {
          if (result[name].length === limit) {
            more = true;
            break;
          }
          const v =
            row.size > Math.min(256 * 1024, pageCapacity - 2048)
              ? {
                  metadataCursor: encode(
                    "value:" + table + ":" + row.position,
                    s,
                    [0],
                  ),
                }
              : normalize(
                  JSON.parse(
                    db
                      .prepare(`SELECT value FROM ${table} WHERE rowid=?`)
                      .get(row.position).value,
                  ),
                );
          if (v.metadataCursor && table === "entities") {
            const e = normalize(
              JSON.parse(
                db
                  .prepare("SELECT value FROM entities WHERE rowid=?")
                  .get(row.position).value,
              ),
            );
            v.entityDefaults = {
              revision: e.revision,
              personalPhotoId: e.personalPhotoId,
              representativePhoto: e.representativePhoto,
            };
          }
          const size = Buffer.byteLength(JSON.stringify(v)) + 256;
          if (size > budget) {
            more = true;
            break;
          }
          budget -= size;
          result[name].push(v);
          positions[i] = row.position;
        }
      },
    );
    return { ...result, nextCursor: more ? encode(scope, s, positions) : null };
  };
  pages.readMetadata = (cursor) => {
    z.string().min(1).max(2048).parse(cursor);
    let scope;
    try {
      scope = JSON.parse(
        Buffer.from(cursor.split(".")[0], "base64url").toString(),
      ).scope;
    } catch {
      throw Error("Invalid metadata cursor");
    }
    if (
      !/^value:(entities|documents|records|entity_history):[1-9][0-9]*$/.test(
        scope,
      )
    )
      throw Error("Invalid metadata cursor");
    const s = state(),
      positions = decode(cursor, scope, s),
      [, table, id] = scope.split(":");
    if (positions.length !== 1) throw Error("Invalid metadata cursor");
    const offset = positions[0];
    const row = db
      .prepare(
        `SELECT substr(value,?,8192) AS text, length(value) AS size FROM ${table} WHERE rowid=?`,
      )
      .get(offset + 1, Number(id));
    if (!row || offset >= row.size) throw Error("Metadata not found");
    return {
      text: row.text,
      nextCursor:
        offset + 8192 < row.size ? encode(scope, s, [offset + 8192]) : null,
    };
  };
  return pages;
}
