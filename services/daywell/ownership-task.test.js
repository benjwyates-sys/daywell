import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.js';
import { createPreferencesStore } from './user-preferences.js';
import { createTools } from './tools.js';

const date = value => ({ status: 'stated', value, precision: 'day', citations: [0] });
export const taskFixture = () => ({
  version: 1, purpose: 'benefit', asOf: '2026-10-15T12:00:00Z',
  dates: [{ kind: 'purchase', date: date('2026-04-01') }, { kind: 'installation', date: date('2026-04-12') }, { kind: 'offer_deadline', date: date('2026-09-30') }],
  findings: [{ label: 'Equipment', text: 'Example refrigerator; serial not on receipt', basis: 'document', citations: [0] }],
  eligibility: { status: 'expired', text: 'The supplied synthetic offer ended September 30; no current benefit established.', citations: [0] },
  progress: { status: 'no_action', text: 'No action needed from the supplied evidence.', citations: [0] }, nextStep: null,
});

test('one receipt → task → corrected later session and selective packet, with no inventory or serial prerequisite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daywell-task-')), path = join(dir, 'records.sqlite');
  let store = createStore(path), preferences = createPreferencesStore(path);
  try {
    let tools = createTools(store, preferences);
    assert.equal(tools.get('get_agent_context').run().onboarding.nextQuestion.stage, 'first_document');
    for (const [id, room] of [['kitchen-fridge', 'Kitchen'], ['utility-fridge', 'Utility']])
      store.putEntity({ id, kind: 'item', name: 'Example refrigerator', details: { room, model: 'EX-1', internalNotes: 'EXCLUDED_PRIVATE_NOTE', credentials: 'EXCLUDED_CREDENTIAL' } });
    assert.equal(tools.get('get_agent_context').run().onboarding.nextQuestion.stage, 'resume_records');
    assert.equal(tools.get('get_agent_context').run().onboarding.opening, null);
    const originalInput = { entityId: 'kitchen-fridge', name: 'synthetic-receipt.pdf', category: 'receipt', source: { kind: 'agent', reference: 'EXCLUDED_MAILBOX_REFERENCE' }, base64: Buffer.from('%PDF-1.4\nSYNTHETIC: purchased Apr 1, installed Apr 12; offer ended Sept 30. No serial.').toString('base64') };
    const doc = store.saveDocument(originalInput);
    store.saveDocument({ ...originalInput, name: 'UNRELATED_WHOLE_HOME_BILL.pdf', base64: Buffer.from('%PDF-1.4\nUNRELATED_BILL').toString('base64') });
    const unrelated = store.saveDocument({ ...originalInput, entityId: 'utility-fridge', name: 'UNRELATED_HOUSEHOLD.pdf' });
    const input = { entityId: 'kitchen-fridge', idempotencyKey: 'first-task', kind: 'purchase', summary: 'Receipt retained; no current offer requires action.', facts: {}, ownershipTask: taskFixture(), evidence: [{ documentId: doc.id, location: 'Page 1, dates and synthetic offer terms', page: 1, section: 'Terms' }], uncertainties: ['Serial number unknown; not needed for this answer.'] };
    input.ownershipTask.dates[1].date.value = '2026-04-02'; // Deliberate client misreading, corrected below.
    const initial = tools.get('save_record').run(input);
    assert.equal(initial.input.ownershipTask.dates[0].date.value, '2026-04-01');
    assert.equal(initial.input.ownershipTask.dates[1].date.value, '2026-04-02');
    assert.equal(store.context('kitchen-fridge').entity.details.serial, undefined);
    assert.throws(() => store.recordPacket({ entityId: 'kitchen-fridge', documentIds: [unrelated.id] }), /not found/);
    assert.throws(() => store.recordPacket({ entityId: 'kitchen-fridge' }), /Select/);
    const corrected = store.saveRecord({ ...input, idempotencyKey: 'date-correction', supersedes: initial.id, ownershipTask: taskFixture(), correction: { reason: 'Agent misread the installation date; original says April 12.', withdrawn: false }, summary: 'Installation confirmed separately from purchase; no action needed.' });
    store.correctEntity({ entityId: 'kitchen-fridge', expectedRevision: 0, idempotencyKey: 'model-correction', details: { ...store.context('kitchen-fridge').entity.details, model: 'EX-1A' }, reason: 'Owner clarified model suffix', source: { kind: 'agent', reference: 'Synthetic owner correction' } });
    preferences.update({ expectedRevision: 0, idempotencyKey: 'satisfied', changes: { onboardingStage: 'complete' }, reason: 'Synthetic owner is satisfied', userInstructionReference: 'Synthetic user answer' });
    assert.throws(() => store.recordPacket({ entityId: 'kitchen-fridge', recordIds: [initial.id] }), /superseded/);
    store.close(); preferences.close(); store = createStore(path); preferences = createPreferencesStore(path); tools = createTools(store, preferences);
    assert.equal(tools.get('get_agent_context').run().onboarding.nextQuestion, null);
    const packet = tools.get('get_record_packet').run({ entityId: 'kitchen-fridge', recordIds: [corrected.id], includeHistory: true });
    assert.equal(packet.entity.details.model, 'EX-1A');
    assert.equal(packet.records[0].id, corrected.id);
    assert.equal(packet.records[0].ownershipTask.dates[1].date.value, '2026-04-12');
    assert.equal(packet.history[0].ownershipTask.dates[1].date.value, '2026-04-02');
    assert.equal(packet.history[0].id, initial.id);
    assert.equal(packet.documents.length, 1);
    assert.ok(!JSON.stringify(packet).includes('EXCLUDED_'));
    assert.ok(!JSON.stringify(packet).includes('UNRELATED_'));
    assert.equal(store.readDocument(doc.id).base64, originalInput.base64);
    assert.deepEqual(store.recordPreview('kitchen-fridge').summaries, [corrected.input.summary]);
    const restored = createStore(join(dir, 'restored.sqlite'));
    try { restored.importArchive(store.exportArchive()); assert.deepEqual(restored.recordPacket({ entityId: 'kitchen-fridge', recordIds: [corrected.id] }).records, packet.records); }
    finally { restored.close(); }
  } finally { store.close(); preferences.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('wrong-equipment correction preserves originals, withdraws assertions and supports re-filing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daywell-association-')); const store = createStore(join(dir, 'records.sqlite'));
  try {
    for (const id of ['kitchen', 'utility']) store.putEntity({ id, kind: 'item', name: id + ' fridge' });
    const d = store.saveDocument({ entityId: 'kitchen', name: 'service.pdf', base64: Buffer.from('%PDF-1.4\nSynthetic service invoice for utility fridge').toString('base64'), source: { kind: 'upload' } });
    const wrong = store.saveRecord({ entityId: 'kitchen', idempotencyKey: 'wrong', kind: 'service', summary: 'Misassigned service', facts: { work: 'Valve replaced' }, evidence: [{ documentId: d.id, location: 'Page 1' }] });
    const withdrawal = { entityId: 'kitchen', idempotencyKey: 'withdraw', supersedes: wrong.id, kind: 'service', summary: 'This invoice belongs to the utility fridge, not the kitchen fridge.', correction: { withdrawn: true, reason: 'Owner and invoice location resolve two similar appliances.', correctEntityId: 'utility' }, facts: {}, evidence: wrong.input.evidence };
    const corrected = store.saveRecord(withdrawal);
    assert.equal(store.saveRecord(withdrawal).id, corrected.id);
    assert.throws(() => store.saveRecord({ ...withdrawal, idempotencyKey: 'bad-withdrawal', facts: { work: 'Valve replaced' } }), /Withdrawn/);
    const bytes = store.readDocument(d.id);
    assert.equal(bytes.associationWarnings.length, 1);
    const copy = store.saveDocument({ entityId: 'utility', name: bytes.name, base64: bytes.base64, source: bytes.source });
    store.saveRecord({ ...wrong.input, entityId: 'utility', idempotencyKey: 'right', summary: 'Utility fridge valve replaced', evidence: [{ documentId: copy.id, location: 'Page 1' }] });
    assert.equal(store.readDocument(copy.id).base64, bytes.base64);
    assert.equal(store.readDocument(copy.id).associationWarnings.length, 0);
    assert.equal(store.recordPacket({ entityId: 'kitchen', documentIds: [d.id] }).documents[0].associationWarnings.length, 1);
    assert.equal(store.recordPreview('kitchen').summaries[0], withdrawal.summary);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('leak observation is separate from diagnosis and coverage; progress and references validate without adjudication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daywell-task-validation-')), store = createStore(join(dir, 'records.sqlite'));
  try {
    store.putEntity({ id: 'fridge', kind: 'item', name: 'Fridge' });
    const doc = store.saveDocument({ entityId: 'fridge', name: 'warranty.pdf', base64: Buffer.from('%PDF-1.4\nSynthetic conditional warranty').toString('base64'), source: { kind: 'upload' } });
    const task = { ...taskFixture(), purpose: 'service', dates: [], findings: [{ label: 'Leak', text: 'Owner reports water under the fridge', basis: 'owner_observation', citations: [] }], eligibility: { status: 'unknown', text: 'Warranty dates alone do not establish coverage for this leak.', citations: [0] }, progress: { status: 'prepared', text: 'Questions for technician prepared; no appointment or request submitted.', citations: [] }, nextStep: 'Ask the technician to diagnose the leak before discussing coverage.' };
    const input = { entityId: 'fridge', idempotencyKey: 'leak', kind: 'observation', summary: 'Leak reported; diagnosis and provider approval unknown.', facts: {}, evidence: [{ documentId: doc.id, location: 'Warranty conditions' }], uncertainties: ['Cause of leak and coverage unknown'], ownershipTask: task };
    const saved = store.saveRecord(input);
    assert.equal(saved.input.ownershipTask.progress.status, 'prepared');
    for (const status of ['submitted', 'approved', 'received'])
      assert.throws(() => store.saveRecord({ ...input, idempotencyKey: status, ownershipTask: { ...task, progress: { status, text: 'Unsupported outcome', citations: [] } } }), /evidence references/);
    assert.throws(() => store.saveRecord({ ...input, ownershipTask: { ...task, eligibility: { status: 'confirmed', text: 'No citation', citations: [] } } }), /cited terms/);
    assert.throws(() => store.saveRecord({ ...input, ownershipTask: { ...task, findings: [{ ...task.findings[0], basis: 'technician_diagnosis' }] } }), /require citations/);
    assert.throws(() => store.saveRecord({ ...input, ownershipTask: { ...task, eligibility: { ...task.eligibility, citations: [4] } } }), /citation index/);
    assert.throws(() => store.saveRecord({ ...input, ownershipTask: { ...task, progress: { status: 'no_action', text: 'Nothing due', citations: [] } } }), /must not manufacture/);
    assert.throws(() => store.saveRecord({ ...input, ownershipTask: { ...task, dates: [{ kind: 'purchase', date: date('2026-02-30') }] } }), /calendar date/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary completed service can have no actionable benefit; evidenced outcomes remain distinct snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daywell-no-action-')), store = createStore(join(dir, 'records.sqlite'));
  try {
    store.putEntity({ id: 'hvac', kind: 'item', name: 'HVAC' });
    const doc = store.saveDocument({ entityId: 'hvac', name: 'completed-service.pdf', category: 'service', base64: Buffer.from('%PDF-1.4\nSynthetic HVAC invoice: service completed Oct 1. No follow-up requested.').toString('base64'), source: { kind: 'upload' } });
    const task = { ...taskFixture(), purpose: 'history', dates: [{ kind: 'service', date: date('2026-10-01') }], findings: [{ label: 'Work completed', text: 'Service completed October 1', basis: 'document', citations: [0] }], eligibility: { status: 'not_applicable', text: 'No benefit is identified in the supplied invoice.', citations: [] }, progress: { status: 'no_action', text: 'No action needed from this service history.', citations: [0] } };
    const saved = store.saveRecord({ entityId: 'hvac', idempotencyKey: 'no-action', kind: 'service', summary: 'HVAC service history retained; no action needed.', facts: {}, ownershipTask: task, evidence: [{ documentId: doc.id, location: 'Page 1 service performed' }], uncertainties: [] });
    assert.equal(saved.input.ownershipTask.nextStep, null);
    assert.equal(saved.input.ownershipTask.progress.status, 'no_action');
    // These are explicit synthetic agent assertions, never simulated provider execution.
    for (const status of ['submitted', 'approved', 'received']) {
      const evidence = store.saveDocument({ entityId: 'hvac', name: `synthetic-${status}.pdf`, base64: Buffer.from(`%PDF-1.4\nSynthetic fixture: ${status} confirmation`).toString('base64'), source: { kind: 'agent' } });
      const result = store.saveRecord({ ...saved.input, idempotencyKey: status, summary: `Synthetic ${status} evidence retained`, ownershipTask: { ...task, purpose: 'benefit', progress: { status, text: `Synthetic ${status} assertion only`, citations: [0] } }, evidence: [{ documentId: evidence.id, location: 'Synthetic confirmation' }] });
      assert.equal(result.input.ownershipTask.progress.status, status);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
