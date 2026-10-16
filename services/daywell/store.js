import { validateArchive } from "./archive-validation.js";
import { ownershipTaskSchema, recordCorrectionSchema, validateOwnershipRecord, packetInputSchema, packetIdentity, packetRecord } from './ownership-task.js';
import {
  initialize,
  pager,
  enforceQuotas,
  usage,
  tables,
  quotaSchema,
} from "./storage-engine.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  entitySchema,
  correctionSchema,
  representative,
  canonical,
} from "./entity-contract.js";
import {
  applianceWarrantySchema,
  validateWarrantyRecord,
} from "./warranty-contract.js";
export { entitySchema, correctionSchema };
export const documentSchema = z.object({
  entityId: z.string(),
  name: z.string().min(1).max(200),
  category: z
    .enum([
      "warranty",
      "manual",
      "service",
      "receipt",
      "other",
      "profile-photo",
    ])
    .default("other"),
  base64: z.string().max(28_000_000),
  source: z.object({
    kind: z.enum(["upload", "gmail", "agent"]),
    reference: z.string().max(1000).optional(),
  }),
});
export const recordSchema = z.object({
  entityId: z.string(),
  idempotencyKey: z.string().min(1).max(200),
  kind: z.enum(["service", "warranty", "observation", "purchase"]),
  summary: z.string().min(1).max(2000),
  facts: z.record(z.unknown()),
  applianceWarranty: applianceWarrantySchema.optional(),
  ownershipTask: ownershipTaskSchema.optional(),
  correction: recordCorrectionSchema.optional(),
  evidence: z
    .array(
      z.object({
        documentId: z.string(),
        location: z.string().min(1).max(500),
        page: z.number().int().positive().optional(),
        section: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .min(1),
  uncertainties: z.array(z.string().max(1000)).default([]),
  supersedes: z.string().optional(),
});
export function createStore(
  path = process.env.DAYWELL_DB ||
    resolve(import.meta.dirname, "data/daywell.sqlite"),
  options = {},
) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    initialize(db, options.quotas);
  } catch (e) {
    db.close();
    throw e;
  }
  const page = pager(db);
  const transaction = (fn, action = "mutation") => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = db.prepare("SELECT total_changes() AS n").get().n;
      const value = fn();
      if (db.prepare("SELECT total_changes() AS n").get().n !== before) {
        enforceQuotas(db);
        db.prepare("INSERT INTO mutation_audit(at,action) VALUES(?,?)").run(
          new Date().toISOString(),
          action,
        );
        db.exec(
          "DELETE FROM mutation_audit WHERE sequence <= (SELECT max(sequence)-1000 FROM mutation_audit); UPDATE storage_state SET generation=generation+1",
        );
        options.beforeCommit?.(); // Injectable failure point for rollback verification; never an HTTP/MCP input.
      }
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const normalize = (e) => ({
    ...e,
    revision: e.revision ?? 0,
    personalPhotoId: e.personalPhotoId ?? null,
    representativePhoto: e.representativePhoto ?? representative(e),
  });
  const entity = (id) => {
    const row = db.prepare("SELECT value FROM entities WHERE id=?").get(id);
    if (!row) throw new Error("Entity not found");
    return normalize(JSON.parse(row.value));
  };
  const associationWarnings = (documentId, entityId) => db.prepare(`
    SELECT r.value FROM records r
    WHERE r.entity_id=? AND json_extract(r.value,'$.input.correction.withdrawn')=1
    AND EXISTS (SELECT 1 FROM json_each(r.value,'$.input.evidence') ref WHERE json_extract(ref.value,'$.documentId')=?)
    AND NOT EXISTS (SELECT 1 FROM records n WHERE n.entity_id=r.entity_id AND json_extract(n.value,'$.input.supersedes')=r.id)
  `).all(entityId, documentId).map(row => {
    const r = JSON.parse(row.value);
    return { recordId: r.id, reason: r.input.correction.reason, status: 'Referenced by a withdrawn record; do not infer equipment association from this original' };
  });
  return {
    close: () => db.close(),
    readMetadata: (cursor) => transaction(() => page.readMetadata(cursor)),
    usage: () => ({
      used: usage(db),
      limits: JSON.parse(
        db.prepare("SELECT quotas FROM storage_state").get().quotas,
      ),
    }),
    configureQuotas(limits) {
      return transaction(() => {
        db.prepare("UPDATE storage_state SET quotas=?").run(
          JSON.stringify(quotaSchema.parse(limits)),
        );
        return this.usage();
      }, "quota-change");
    },
    exportArchive() {
      return transaction(() => ({
        format: "daywell",
        version: 1,
        schemaVersion: 1,
        tables: Object.fromEntries(
          Object.entries(tables).map(([table, columns]) => [
            table,
            db
              .prepare(
                `SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`,
              )
              .all()
              .map((row) => ({
                ...row,
                ...(table === "documents"
                  ? { bytes: Buffer.from(row.bytes).toString("base64") }
                  : {}),
              })),
          ]),
        ),
      }));
    },
    deleteEntity(id, confirmation) {
      if (confirmation !== "DELETE " + id)
        throw Error("Explicit confirmation required: DELETE " + id);
      return transaction(() => {
        entity(id);
        for (const table of ["records", "entity_history", "documents"])
          db.prepare(`DELETE FROM ${table} WHERE entity_id=?`).run(id);
        db.prepare(
          "DELETE FROM entity_operations WHERE json_extract(result,'$.id')=?",
        ).run(id);
        db.prepare("DELETE FROM entities WHERE id=?").run(id);
        return { deleted: true };
      }, "entity-delete");
    },
    importArchive(archive) {
      validateArchive(archive);
      return transaction(() => {
        if (usage(db).rows)
          throw Error(
            "Import requires an empty destination; merge/overwrite is not supported",
          );
        for (const [table, columns] of Object.entries(tables))
          for (const row of archive.tables[table])
            db.prepare(
              `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
            ).run(
              ...columns.map((c) =>
                table === "documents" && c === "bytes"
                  ? Buffer.from(row[c], "base64")
                  : row[c],
              ),
            );
        return { imported: true };
      }, "archive-import");
    },
    list: (input = {}) =>
      transaction(() =>
        page("entities", input, [
          { name: "entities", table: "entities", normalize },
        ]),
      ),
    putEntity(input) {
      return transaction(() => {
        const e = entitySchema.parse(input),
          requestKey = "create:" + e.id,
          encoded = canonical(e);
        const operation = db
          .prepare("SELECT input FROM entity_operations WHERE request_key=?")
          .get(requestKey);
        if (operation) {
          if (operation.input !== encoded)
            throw new Error(
              "Entity ID already used for different content; use correct_entity",
            );
          return entity(e.id);
        }
        const prior = db
          .prepare("SELECT value FROM entities WHERE id=?")
          .get(e.id);
        if (prior) {
          const saved = entity(e.id);
          if (
            canonical({
              id: saved.id,
              kind: saved.kind,
              name: saved.name,
              details: saved.details,
            }) !== encoded
          )
            throw new Error(
              "Entity ID already exists; read context and use correct_entity",
            );
          return saved;
        }
        const value = {
          ...e,
          revision: 0,
          personalPhotoId: null,
          representativePhoto: representative(e),
        };
        db.prepare("INSERT INTO entities VALUES (?,?)").run(
          e.id,
          JSON.stringify(value),
        );
        db.prepare("INSERT INTO entity_operations VALUES (?,?,?)").run(
          requestKey,
          encoded,
          JSON.stringify(value),
        );
        return value;
      }, "entity-create");
    },
    correctEntity(input) {
      return transaction(() => {
        const c = correctionSchema.parse(input),
          requestKey = "correct:" + c.idempotencyKey,
          encoded = canonical(c);
        const operation = db
          .prepare(
            "SELECT input,result FROM entity_operations WHERE request_key=?",
          )
          .get(requestKey);
        if (operation) {
          if (operation.input !== encoded)
            throw new Error(
              "Idempotency key already used for different content",
            );
          return JSON.parse(operation.result);
        }
        const prior = entity(c.entityId);
        if (prior.revision !== c.expectedRevision)
          throw new Error(
            "Entity revision conflict; read latest context before correcting",
          );
        if (c.personalPhotoId) {
          const row = db
            .prepare("SELECT value FROM documents WHERE id=? AND entity_id=?")
            .get(c.personalPhotoId, c.entityId);
          if (!row || !JSON.parse(row.value).mime.startsWith("image/"))
            throw new Error(
              "Personal photo must be an image original belonging to this entity",
            );
        }
        const value = {
          ...prior,
          name: c.name ?? prior.name,
          details: c.details ?? prior.details,
          personalPhotoId:
            c.personalPhotoId === undefined
              ? prior.personalPhotoId
              : c.personalPhotoId,
          revision: prior.revision + 1,
        };
        value.representativePhoto = representative(value);
        db.prepare("UPDATE entities SET value=? WHERE id=?").run(
          JSON.stringify(value),
          value.id,
        );
        db.prepare("INSERT INTO entity_history VALUES (?,?)").run(
          value.id,
          JSON.stringify({
            before: prior,
            after: value,
            input: c,
            createdAt: new Date().toISOString(),
          }),
        );
        db.prepare("INSERT INTO entity_operations VALUES (?,?,?)").run(
          requestKey,
          encoded,
          JSON.stringify(value),
        );
        return value;
      }, "entity-correct");
    },
    context(id, input = {}) {
      return transaction(() =>
        page(
          "context:" + id,
          input,
          [
            { name: "entityHistory", table: "entity_history", entityId: id },
            { name: "documents", table: "documents", entityId: id },
            { name: "records", table: "records", entityId: id },
          ],
          {
            entity: entity(id),
            policy: {
              inference: "agent-side only",
              emailAccess: false,
              coverage: "Agent interpretation is not provider approval",
            },
          },
        ),
      );
    },
    recordPreview(id) {
      return transaction(() => {
        const e = entity(id);
        const documents = db.prepare('SELECT value FROM documents WHERE entity_id=? ORDER BY rowid DESC LIMIT 3').all(id).map(row => JSON.parse(row.value));
        const records = db.prepare("SELECT r.value FROM records r WHERE r.entity_id=? AND NOT EXISTS (SELECT 1 FROM records n WHERE n.entity_id=r.entity_id AND json_extract(n.value,'$.input.supersedes')=r.id) ORDER BY r.rowid DESC LIMIT 3").all(id).map(row => JSON.parse(row.value));
        return { id: e.id, name: e.name, kind: e.kind, documents: documents.map(d => ({ id: d.id, name: d.name })), summaries: records.map(r => r.input.summary) };
      });
    },
    recordPacket(input) {
      const selection = packetInputSchema.parse(input);
      if (!selection.recordIds.length && !selection.documentIds.length) throw Error('Select records or originals for this task');
      return transaction(() => {
        const e = entity(selection.entityId), records = [], history = [], documents = [];
        const readRecord = id => {
          const row = db.prepare('SELECT value FROM records WHERE id=? AND entity_id=?').get(id, e.id);
          if (!row) throw Error('Selected record not found on this entity');
          return JSON.parse(row.value);
        };
        const documentIds = new Set(selection.documentIds), visited = new Set();
        for (const id of new Set(selection.recordIds)) {
          const r = readRecord(id);
          if (db.prepare("SELECT 1 FROM records WHERE entity_id=? AND json_extract(value,'$.input.supersedes')=?").get(e.id, id))
            throw Error('Selected record was superseded; refresh context and select its current correction');
          records.push(packetRecord(r));
          for (const ref of r.input.evidence) documentIds.add(ref.documentId);
          let previous = selection.includeHistory ? r.input.supersedes : null;
          while (previous && !visited.has(previous)) {
            if (history.length >= 50) throw Error('Packet history exceeds 50 records; select fewer records or omit history');
            visited.add(previous);
            const old = readRecord(previous);
            history.push(packetRecord(old));
            for (const ref of old.input.evidence) documentIds.add(ref.documentId);
            previous = old.input.supersedes;
          }
        }
        for (const id of documentIds) {
          const row = db.prepare('SELECT value FROM documents WHERE id=? AND entity_id=?').get(id, e.id);
          if (!row) throw Error('Selected original not found on this entity');
          const d = JSON.parse(row.value);
          documents.push({ id: d.id, name: d.name, category: d.category, mime: d.mime, bytes: d.bytes, hash: d.hash, associationWarnings: associationWarnings(d.id, e.id) });
        }
        const packet = { format: 'daywell-record-packet', version: 1, generatedAt: new Date().toISOString(),
          entity: packetIdentity(e), records, history, documents,
          notice: 'Selected agent-supplied records only. History is superseded, not current fact. Original bytes are separate: use read_original with the listed IDs. Review selected text and originals before sharing; they may contain personal information. No submission, booking or provider approval is performed by this export.' };
        if (Buffer.byteLength(JSON.stringify(packet)) > 262144) throw Error('Packet exceeds 256 KiB; select fewer records or omit history');
        return packet;
      });
    },
    saveDocument(input) {
      return transaction(() => {
        const d = documentSchema.parse(input);
        entity(d.entityId);
        const bytes = Buffer.from(d.base64, "base64");
        if (
          !bytes.length ||
          bytes.length > 20 * 1024 * 1024 ||
          bytes.toString("base64") !== d.base64
        )
          throw new Error("Invalid base64 or file size");
        const mime =
          bytes.subarray(0, 5).toString() === "%PDF-"
            ? "application/pdf"
            : bytes
                  .subarray(0, 8)
                  .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              ? "image/png"
              : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                ? "image/jpeg"
                : bytes.subarray(0, 4).toString() === "RIFF" &&
                    bytes.subarray(8, 12).toString() === "WEBP"
                  ? "image/webp"
                  : null;
        if (!mime)
          throw new Error(
            "Only PDF, JPG, PNG and WebP originals are supported",
          );
        if (d.category === "profile-photo" && !mime.startsWith("image/"))
          throw new Error("Profile photos must be image originals");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const prior = db
          .prepare("SELECT value FROM documents WHERE entity_id=? AND hash=?")
          .get(d.entityId, hash);
        if (prior) return JSON.parse(prior.value);
        const { base64, ...meta } = d;
        const value = {
          ...meta,
          id: randomUUID(),
          mime,
          bytes: bytes.length,
          hash,
          addedAt: new Date().toISOString(),
          status: "original-saved",
        };
        db.prepare("INSERT INTO documents VALUES(?,?,?,?,?)").run(
          value.id,
          d.entityId,
          hash,
          JSON.stringify(value),
          bytes,
        );
        return value;
      }, "original-save");
    },
    readDocument(id) {
      const row = db
        .prepare("SELECT value, bytes FROM documents WHERE id=?")
        .get(id);
      if (!row) throw new Error("Document not found");
      return {
        ...JSON.parse(row.value),
        associationWarnings: associationWarnings(id, JSON.parse(row.value).entityId),
        base64: Buffer.from(row.bytes).toString("base64"),
      };
    },
    saveRecord(input) {
      return transaction(() => {
        const r = recordSchema.parse(input);
        if (Buffer.byteLength(JSON.stringify(r)) > 65536)
          throw Error("Record exceeds 65536 UTF-8 bytes");
        validateWarrantyRecord(r, entity(r.entityId));
        validateOwnershipRecord(r, entity(r.entityId));
        if (r.correction?.correctEntityId) entity(r.correction.correctEntityId);
        const prior = db
          .prepare("SELECT value FROM records WHERE request_key=?")
          .get(r.idempotencyKey);
        if (prior) {
          const saved = JSON.parse(prior.value);
          if (canonical(saved.input) !== canonical(r))
            throw new Error(
              "Idempotency key already used for different content",
            );
          return saved;
        }
        for (const ref of r.evidence) {
          const doc = db
            .prepare("SELECT entity_id FROM documents WHERE id=?")
            .get(ref.documentId);
          if (!doc || doc.entity_id !== r.entityId)
            throw new Error("Evidence must belong to this entity");
        }
        if (r.supersedes) {
          const old = db
            .prepare("SELECT entity_id FROM records WHERE id=?")
            .get(r.supersedes);
          if (!old || old.entity_id !== r.entityId)
            throw new Error("Superseded record must belong to this entity");
          if (
            db
              .prepare(
                "SELECT 1 FROM records WHERE json_extract(value,'$.input.supersedes')=?",
              )
              .get(r.supersedes)
          )
            throw new Error("Record already superseded; read latest context");
        }
        const record = {
          id: randomUUID(),
          input: r,
          createdAt: new Date().toISOString(),
          origin: "agent-supplied",
          verification: "not independently verified by Daywell",
        };
        db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
          record.id,
          r.entityId,
          r.idempotencyKey,
          JSON.stringify(record),
        );
        return record;
      }, "record-save");
    },
  };
}
