import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonical, entitySchema } from "./entity-contract.js";

const shortText = z.string().trim().min(1).max(500);
const question = z.enum(["identity", "purchase", "receipt", "maintenance", "warranty", "manual", "photo", "other_documents"]);
const onboardingItem = z.object({
  entityId: entitySchema.shape.id,
  completedQuestions: z.array(question).max(8),
  deferredQuestions: z.array(question).max(8),
}).strict().refine(v => !v.completedQuestions.some(q => v.deferredQuestions.includes(q)), "A question cannot be both completed and deferred");
const homeStep = z.enum(["ownership", "properties", "addresses", "property_context"]);
const propertyProgress = z.object({
  propertyId: entitySchema.shape.id,
  checklist: z.array(z.object({
    topic: shortText,
    status: z.enum(["discussed", "user_reported", "reference_only", "documented", "unknown", "deferred", "not_applicable"]),
    reopenWhen: shortText.nullable(),
  }).strict()).max(30).refine(items => new Set(items.map(i => i.topic)).size === items.length, "Duplicate checklist topic"),
  nextQuestion: shortText.nullable(),
}).strict();
const homeSetup = z.object({
  propertyProgress: z.array(propertyProgress).max(100).refine(items => new Set(items.map(i => i.propertyId)).size === items.length, "Duplicate property progress").optional(),
  tenure: z.enum(["own", "rent", "other", "unknown"]).nullable(),
  multipleHomes: z.enum(["yes", "no", "unknown"]).nullable(),
  propertyIds: z.array(entitySchema.shape.id).max(100).refine(ids => new Set(ids).size === ids.length, "Duplicate property reference"),
  completedSteps: z.array(homeStep).max(4),
  deferredSteps: z.array(homeStep).max(4),
}).strict().refine(v => !v.completedSteps.some(q => v.deferredSteps.includes(q)), "A home step cannot be both completed and deferred")
.refine(v => (v.propertyProgress || []).every(p => v.propertyIds.includes(p.propertyId)), "Progress must reference a listed property")
.refine(v => !v.completedSteps.includes("ownership") || v.tenure !== null, "Completed ownership requires a user answer")
.refine(v => !v.completedSteps.includes("properties") || v.multipleHomes !== null, "Completed properties requires a user answer");
const fields = {
  goals: z.array(shortText).max(10),
  focusAreas: z.array(z.enum(["home", "garage", "kitchen"])).max(3),
  maintenanceMode: z.enum(["off", "suggest", "maintain_within_authorized_scope"]),
  notificationStyle: z.enum(["meaningful_changes", "session_summary"]),
  homeSetup,
  onboardingStage: z.enum(["ownership", "properties", "addresses", "property_context", "not_started", "inventory", "first_win", "expand", "complete"]),
  reviewedAreas: z.array(z.enum(["home", "garage", "kitchen"])).max(3),
  deferredAreas: z.array(z.enum(["home", "garage", "kitchen"])).max(3),
  onboardingPaused: z.boolean(),
  onboardingItems: z.array(onboardingItem).max(100).refine(items => new Set(items.map(i => i.entityId)).size === items.length, "One progress entry per entity"),
};
export const preferencesInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(200),
  changes: z.object(fields).partial().strict().refine(v => Object.keys(v).length > 0, "A preference change is required"),
  reason: shortText,
  userInstructionReference: shortText,
}).strict();
export const preferenceHistoryInput = z.object({
  afterRevision: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(25).default(10),
}).strict();
const empty = () => ({ revision: 0, configured: false, goals: [], focusAreas: [], maintenanceMode: "suggest", notificationStyle: "meaningful_changes", onboardingStage: "not_started", reviewedAreas: [], deferredAreas: [], onboardingPaused: false, onboardingItems: [], updatedAt: null });

// Separate bounded account-preference store; record schema/export formats are unchanged.
// One companion file per explicit record DB, so separate local stores never share preferences.
export function createPreferencesStore(recordPath) {
  const path = recordPath + ".preferences.sqlite";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > 1) { db.close(); throw Error("Unsupported preferences database version"); }
  db.exec("CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, input TEXT NOT NULL, result TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL); PRAGMA user_version=1;");
  const get = () => {
    const row = db.prepare("SELECT result FROM changes ORDER BY revision DESC LIMIT 1").get();
    return { ...empty(), ...(row ? JSON.parse(row.result) : {}), homeSetup: row ? (JSON.parse(row.result).homeSetup ?? null) : null };
  };
  return {
    close: () => db.close(),
    get,
    update(input, actor = "local-agent") {
      const parsed = preferencesInput.parse(input), encoded = canonical(parsed);
      if (Buffer.byteLength(encoded) > 32768) throw Error("Preference input exceeds 32768 bytes");
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = db.prepare("SELECT input,result FROM changes WHERE request_key=?").get(parsed.idempotencyKey);
        if (prior) {
          if (prior.input !== encoded) throw Error("Idempotency conflict");
          db.exec("COMMIT"); return JSON.parse(prior.result);
        }
        const current = get();
        if (current.revision !== parsed.expectedRevision) throw Error("Preference revision conflict");
        if (current.revision >= 1000) throw Error("Preference history quota exceeded");
        const at = new Date().toISOString();
        const result = { ...current, ...parsed.changes, configured: true, revision: current.revision + 1, updatedAt: at };
        if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw Error("Preferences exceed 32768 bytes");
        db.prepare("INSERT INTO changes(revision,request_key,input,result,actor,at) VALUES(?,?,?,?,?,?)")
          .run(result.revision, parsed.idempotencyKey, encoded, JSON.stringify(result), actor, at);
        db.exec("COMMIT"); return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    history(input) {
      const { afterRevision, limit } = preferenceHistoryInput.parse(input);
      const rows = db.prepare("SELECT * FROM changes WHERE revision>? ORDER BY revision LIMIT ?").all(afterRevision, limit + 1);
      const hasMore = rows.length > limit;
      const changes = rows.slice(0, limit).map(row => ({ revision: row.revision, input: JSON.parse(row.input), result: JSON.parse(row.result), actor: row.actor, at: row.at }));
      return { changes, nextAfterRevision: hasMore ? changes.at(-1).revision : null };
    },
  };
}
