import { createHash } from "node:crypto";
import { z } from "zod";
import { tables } from "./storage-engine.js";
import {
  entitySchema,
  correctionSchema,
  canonical,
} from "./entity-contract.js";
import { documentSchema, recordSchema } from "./store.js";
import { validateWarrantyRecord } from "./warranty-contract.js";
import { validateOwnershipRecord } from './ownership-task.js';
const uuid = z.string().uuid();
const fail = (message) => {
  throw Error("Invalid archive: " + message);
};
export function validateArchive(archive) {
  z.object({
    format: z.literal("daywell"),
    version: z.literal(1),
    schemaVersion: z.literal(1),
    tables: z
      .object(
        Object.fromEntries(
          Object.entries(tables).map(([name, cols]) => [
            name,
            z.array(
              z
                .object(Object.fromEntries(cols.map((c) => [c, z.string()])))
                .strict(),
            ),
          ]),
        ),
      )
      .strict(),
  })
    .strict()
    .parse(archive);
  const t = archive.tables,
    entities = new Map(),
    docs = new Map(),
    records = new Map(),
    keys = new Set(),
    successors = new Set();
  function identity(e) {
    // Baseline identities allowed arbitrary JSON details; preserve them on import.
    entitySchema
      .extend({
        name: z.string().min(1).max(200),
        details: z.record(z.unknown()),
      })
      .parse({
        id: e.id,
        kind: e.kind,
        name: e.name,
        details: e.details,
      });
    if (
      e.revision !== undefined &&
      (!Number.isSafeInteger(e.revision) || e.revision < 0)
    )
      fail("invalid revision");
    if (e.personalPhotoId != null) uuid.parse(e.personalPhotoId);
    return e;
  }
  for (const row of t.entities) {
    const e = identity(JSON.parse(row.value));
    if (row.id !== e.id || entities.has(e.id))
      fail("entity identity collision");
    entities.set(e.id, e);
  }
  for (const row of t.documents) {
    const d = JSON.parse(row.value),
      bytes = Buffer.from(row.bytes, "base64");
    uuid.parse(d.id);
    documentSchema.parse({ ...d, base64: row.bytes });
    const hash = createHash("sha256").update(bytes).digest("hex");
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
    if (
      !bytes.length ||
      bytes.length > 20 * 1024 * 1024 ||
      row.bytes !== bytes.toString("base64") ||
      d.bytes !== bytes.length ||
      hash !== d.hash ||
      hash !== row.hash ||
      row.id !== d.id ||
      row.entity_id !== d.entityId ||
      !entities.has(d.entityId) ||
      docs.has(d.id) ||
      !mime ||
      mime !== d.mime ||
      (d.category === "profile-photo" && !mime.startsWith("image/"))
    )
      fail("original identity, hash, type or reference");
    const key = d.entityId + ":" + hash;
    if (keys.has(key)) fail("duplicate original");
    keys.add(key);
    docs.set(d.id, d);
  }
  const photo = (e) => {
    if (
      e.personalPhotoId &&
      (!docs.get(e.personalPhotoId)?.mime.startsWith("image/") ||
        docs.get(e.personalPhotoId)?.entityId !== e.id)
    )
      fail("photo reference");
  };
  for (const e of entities.values()) photo(e);
  keys.clear();
  for (const row of t.records) {
    const r = JSON.parse(row.value),
      input = recordSchema.parse(r.input);
    uuid.parse(r.id);
    if (
      row.id !== r.id ||
      row.entity_id !== input.entityId ||
      row.request_key !== input.idempotencyKey ||
      !entities.has(input.entityId) ||
      records.has(r.id) ||
      keys.has(row.request_key)
    )
      fail("record identity or key");
    validateWarrantyRecord(input, entities.get(input.entityId));
    validateOwnershipRecord(input, entities.get(input.entityId));
    for (const ref of input.evidence)
      if (docs.get(ref.documentId)?.entityId !== input.entityId)
        fail("evidence reference");
    if (input.supersedes) {
      if (
        records.get(input.supersedes)?.input.entityId !== input.entityId ||
        successors.has(input.supersedes)
      )
        fail("correction cycle, order, branch or reference");
      successors.add(input.supersedes);
    }
    records.set(r.id, r);
    keys.add(row.request_key);
  }
  const last = new Map(),
    histories = new Map(),
    first = new Map();
  for (const row of t.entity_history) {
    const h = JSON.parse(row.value),
      c = correctionSchema.parse(h.input),
      before = identity(h.before),
      after = identity(h.after);
    photo(before);
    photo(after);
    if (!last.has(before.id)) {
      if ((before.revision ?? 0) !== 0)
        fail("identity history must begin at revision zero");
      first.set(before.id, before);
    }
    if (
      !entities.has(row.entity_id) ||
      c.entityId !== row.entity_id ||
      before.id !== row.entity_id ||
      after.id !== before.id ||
      before.kind !== after.kind ||
      (before.revision ?? 0) !== c.expectedRevision ||
      after.revision !== c.expectedRevision + 1 ||
      (last.has(before.id) &&
        canonical(last.get(before.id)) !== canonical(before))
    )
      fail("identity history chain");
    const expected = {
      ...before,
      name: c.name ?? before.name,
      details: c.details ?? before.details,
      personalPhotoId:
        c.personalPhotoId === undefined
          ? before.personalPhotoId
          : c.personalPhotoId,
      revision: after.revision,
      representativePhoto: after.representativePhoto,
    };
    if (canonical(expected) !== canonical(after))
      fail("identity correction result");
    if (histories.has(c.idempotencyKey)) fail("duplicate correction key");
    histories.set(c.idempotencyKey, h);
    last.set(after.id, after);
  }
  for (const [id, value] of last)
    if (canonical(value) !== canonical(entities.get(id)))
      fail("current identity differs from history");
  for (const e of entities.values())
    if ((e.revision ?? 0) > 0 && !last.has(e.id))
      fail("missing identity history");
  keys.clear();
  for (const row of t.entity_operations) {
    const input = JSON.parse(row.input),
      result = identity(JSON.parse(row.result));
    photo(result);
    if (keys.has(row.request_key) || !entities.has(result.id))
      fail("operation collision or reference");
    keys.add(row.request_key);
    if (row.request_key.startsWith("create:")) {
      const e = entitySchema.parse(input);
      if (
        row.request_key !== "create:" + e.id ||
        e.id !== result.id ||
        (result.revision ?? 0) !== 0 ||
        canonical(e) !==
          canonical({
            id: result.id,
            kind: result.kind,
            name: result.name,
            details: result.details,
          })
      )
        fail("creation operation");
      const start = first.get(e.id) ?? entities.get(e.id);
      if (
        canonical(e) !==
        canonical({
          id: start.id,
          kind: start.kind,
          name: start.name,
          details: start.details,
        })
      )
        fail("creation differs from first identity");
    } else if (row.request_key.startsWith("correct:")) {
      const c = correctionSchema.parse(input),
        h = histories.get(c.idempotencyKey);
      if (
        row.request_key !== "correct:" + c.idempotencyKey ||
        !h ||
        canonical(h.input) !== canonical(input) ||
        canonical(h.after) !== canonical(result)
      )
        fail("correction operation");
    } else fail("unknown operation");
  }
  for (const key of histories.keys())
    if (!keys.has("correct:" + key)) fail("missing correction operation");
}
