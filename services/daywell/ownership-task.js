import { z } from 'zod';
import { applianceWarrantySchema } from './warranty-contract.js';

const text = z.string().trim().min(1).max(2000);
const citations = z.array(z.number().int().nonnegative()).max(50);
// A client-authored snapshot of one ownership question, not a workflow engine.
export const ownershipTaskSchema = z.object({
  version: z.literal(1),
  purpose: z.enum(['registration', 'benefit', 'service', 'history']),
  asOf: z.string().datetime({ offset: true }),
  dates: z.array(z.object({
    kind: z.enum(['purchase', 'installation', 'service', 'offer_deadline']),
    date: applianceWarrantySchema.shape.purchaseDate,
  }).strict()).max(20),
  findings: z.array(z.object({
    label: text,
    text,
    basis: z.enum(['document', 'owner_observation', 'technician_diagnosis', 'agent_conclusion']),
    citations,
  }).strict()).max(30),
  eligibility: z.object({
    status: z.enum(['unknown', 'possible', 'confirmed', 'ineligible', 'expired', 'not_applicable']),
    text, citations,
  }).strict(),
  progress: z.object({
    status: z.enum(['no_action', 'needs_information', 'prepared', 'submitted', 'approved', 'received']),
    text, citations,
  }).strict(),
  nextStep: text.nullable(),
}).strict();

export const recordCorrectionSchema = z.object({
  reason: text,
  withdrawn: z.boolean(),
  correctEntityId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
}).strict();

export function validateOwnershipRecord(record, entity) {
  const task = record.ownershipTask;
  if (record.correction) {
    if (!record.supersedes) throw Error('A record correction requires supersedes');
    if (record.correction.correctEntityId && (!record.correction.withdrawn || record.correction.correctEntityId === record.entityId))
      throw Error('An equipment reassociation must withdraw the incorrect record and name a different entity');
    if (record.correction.withdrawn && (task || record.applianceWarranty || Object.keys(record.facts).length))
      throw Error('Withdrawn records retain evidence and a reason, not current facts or conclusions');
  }
  if (!task) return;
  if (entity.kind !== 'item' || record.applianceWarranty || Object.keys(record.facts).length)
    throw Error('ownershipTask requires a Home item, empty facts and no applianceWarranty');
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const index of value.citations || []) {
      if (!record.evidence[index]) throw Error('Task citation index does not exist in evidence');
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(task);
  for (const finding of task.findings)
    if (finding.basis !== 'owner_observation' && !finding.citations.length)
      throw Error('Document, diagnosis and conclusion findings require citations');
  if (['confirmed', 'ineligible', 'expired'].includes(task.eligibility.status) && !task.eligibility.citations.length)
    throw Error('Eligibility conclusions require cited terms or confirmation');
  if (['submitted', 'approved', 'received'].includes(task.progress.status) && !task.progress.citations.length)
    throw Error('Submission, approval and receipt require their own evidence references');
  if (task.progress.status === 'no_action' && task.nextStep !== null)
    throw Error('A no-action snapshot must not manufacture a next step');
}

export const packetInputSchema = z.object({
  entityId: z.string(),
  recordIds: z.array(z.string().uuid()).max(20).default([]),
  documentIds: z.array(z.string().uuid()).max(20).default([]),
  includeHistory: z.boolean().default(false),
}).strict();

// Deliberately exclude arbitrary entity details, account preferences, operation keys
// and source references (which can contain mailbox identifiers).
export function packetIdentity(entity) {
  return { id: entity.id, name: entity.name, kind: entity.kind, revision: entity.revision ?? 0,
    details: Object.fromEntries(['room', 'product', 'brand', 'model', 'serial'].filter(k => typeof entity.details[k] === 'string').map(k => [k, entity.details[k]])) };
}
export function packetRecord(record) {
  const { kind, summary, evidence, uncertainties, supersedes, ownershipTask, applianceWarranty, correction } = record.input;
  return { id: record.id, createdAt: record.createdAt, kind, summary, evidence, uncertainties, supersedes, ownershipTask, applianceWarranty,
    correction: correction ? { reason: correction.reason, withdrawn: correction.withdrawn } : undefined,
    origin: 'agent-supplied; not independently verified by Daywell' };
}
