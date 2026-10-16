import { z } from "zod";
import { readFileSync } from "node:fs";

const text = z.string().trim().min(1).max(200);
const details = z.record(z.unknown()).superRefine((value, ctx) => {
  if (JSON.stringify(value).length > 16000)
    ctx.addIssue({
      code: "custom",
      message: "Details exceed 16000 characters",
    });
  for (const key of [
    "room",
    "product",
    "brand",
    "model",
    "make",
    "serial",
    "year",
  ]) {
    if (
      value[key] !== undefined &&
      !(typeof value[key] === "string" && value[key].length <= 200) &&
      !(
        key === "year" &&
        Number.isInteger(value[key]) &&
        value[key] >= 1900 &&
        value[key] <= 2200
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid identity field: ${key}`,
      });
    }
  }
});
export const entitySchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    kind: z.enum(["vehicle", "item", "kitchen"]),
    name: text,
    details: details.default({}),
  })
  .strict();
export const correctionInputSchema = z
  .object({
    entityId: entitySchema.shape.id,
    idempotencyKey: text,
    expectedRevision: z.number().int().nonnegative(),
    name: text.optional(),
    details: details.optional(),
    personalPhotoId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(1).max(1000),
    source: z
      .object({
        kind: z.enum(["agent", "companion"]),
        reference: z.string().max(1000).optional(),
      })
      .strict(),
  })
  .strict();
export const correctionSchema = correctionInputSchema.refine(
  (v) =>
    v.name !== undefined ||
    v.details !== undefined ||
    v.personalPhotoId !== undefined,
  "A correction is required",
);
// A checked-in licensed catalog is a deterministic identity lookup, never an ownership seed.
const catalog = JSON.parse(
  readFileSync(
    new URL(
      "../../prototypes/daywell-demo/assets/vehicles/catalog.js",
      import.meta.url,
    ),
    "utf8",
  )
    .replace(/^window.vehiclePhotoCatalog = /, "")
    .replace(/;\s*$/, ""),
);
const key = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
export function representative(entity) {
  if (entity.kind !== "vehicle") return null;
  const match = catalog.find((p) =>
    ["year", "make", "model"].every(
      (field) => key(p[field]) === key(entity.details[field]),
    ),
  );
  return match ? { ...match } : null;
}
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sort(value[k])]),
    );
  return value;
}
