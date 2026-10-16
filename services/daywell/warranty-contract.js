import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const citations = z.array(z.number().int().nonnegative()).min(1).max(50);
// Citation indexes address the parent record's evidence array. These are assertions,
// never a server verdict about whether the referenced original supports the text.
export const claim = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stated"), text, citations }).strict(),
  z.object({ status: z.literal("uncertain"), text, citations }).strict(),
  z.object({ status: z.literal("unknown"), reason: text }).strict(),
]);
const dateValue = z
  .object({
    status: z.enum(["stated", "uncertain"]),
    value: text,
    precision: z.enum(["day", "month", "year"]),
    citations,
    note: text.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const patterns = {
      day: /^\d{4}-\d{2}-\d{2}$/,
      month: /^\d{4}-\d{2}$/,
      year: /^\d{4}$/,
    };
    const expanded =
      d.value +
      (d.precision === "year"
        ? "-01-01"
        : d.precision === "month"
          ? "-01"
          : "");
    const parsed = new Date(expanded + "T00:00:00Z");
    if (
      !patterns[d.precision].test(d.value) ||
      !Number.isFinite(+parsed) ||
      parsed.toISOString().slice(0, 10) !== expanded
    )
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "Use a valid calendar date matching day (YYYY-MM-DD), month (YYYY-MM), or year (YYYY) precision",
      });
  });
const date = z.union([
  dateValue,
  z.object({ status: z.literal("unknown"), reason: text }).strict(),
]);
export const applianceWarrantySchema = z
  .object({
    version: z.literal(1),
    asOf: z.string().datetime({ offset: true }),
    productIdentity: claim,
    purchaseDate: date,
    effectiveDate: date,
    terms: z
      .array(
        z.object({ component: claim, duration: claim, endDate: date }).strict(),
      )
      .max(50),
    clauses: z
      .array(
        z
          .object({
            kind: z.enum(["inclusion", "exclusion", "condition"]),
            statement: claim,
          })
          .strict(),
      )
      .max(100),
    eligibility: claim,
    reportedSymptom: claim,
    diagnosis: claim,
    possibleCoverage: claim,
    providerApproval: claim,
    interpretation: claim,
    missingFacts: z.array(text).max(50),
    proposedNextAction: z
      .object({ text, requiresUserApproval: z.literal(true) })
      .strict(),
  })
  .strict();

export function validateWarrantyRecord(record, entity) {
  const w = record.applianceWarranty;
  if (!w) return;
  if (entity.kind !== "item" || record.kind !== "warranty")
    throw Error("applianceWarranty requires an item entity and kind warranty");
  if (Object.keys(record.facts).length)
    throw Error(
      "Typed applianceWarranty uses cited fields; facts must be empty",
    );
  if (
    w.interpretation.status === "unknown" ||
    record.summary !== w.interpretation.text
  )
    throw Error(
      "summary must equal the cited applianceWarranty.interpretation.text",
    );
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.citations)
      for (const index of value.citations) {
        const ref = record.evidence[index];
        if (!ref)
          throw Error(`Citation index ${index} does not exist in evidence`);
        if (!ref.page || !ref.section)
          throw Error(
            `Evidence ${index} requires a page and section for applianceWarranty claims`,
          );
      }
    for (const child of Object.values(value)) visit(child);
  };
  visit(w);
}
