import { expect, test } from 'vitest';
import { buildExportBlocks } from './content';
import { exportPreview } from './fixtures.test-support';
test('literal selected content includes source/date and truthful notes/task provenance', () => {
 const p = exportPreview(), original = structuredClone(p); const blocks = buildExportBlocks(p);
 const text = blocks.map(block => block.text).join('\n');
 for (const value of [p.snapshot.title, p.snapshot.sourceRevision, p.snapshot.generatedAt, 'Ana', 'Ação', '<b>Plain notes</b>', 'Enviar proposta', 'To João']) expect(text).toContain(value);
 expect(text).toContain('Unknown source'); expect(text).toContain('Earlier source'); expect(text).not.toContain('Due: null');
 expect(p).toEqual(original);
});
test('omits disabled fields and unselected sections even if a stale input DTO carries them', () => {
 const p = exportPreview(); p.selection = { transcript: false, notes: false, taskIds: ['task'], speakers: false, timestamps: false };
 const text = buildExportBlocks(p).map(block => block.text).join('\n'); expect(text).not.toContain('Ação'); expect(text).not.toContain('Plain notes'); expect(text).toContain('Enviar proposta');
 const transcript = exportPreview(); transcript.selection = { transcript: true, notes: false, taskIds: [], speakers: false, timestamps: false };
 const literal = buildExportBlocks(transcript).map(block => block.text).join('\n'); expect(literal).not.toContain('Ana'); expect(literal).not.toContain('[00:00'); expect(literal).not.toContain('Enviar proposta');
});
test('untimed notes-only documents and multiline text produce plain blocks', () => {
 const p = exportPreview(); p.selection = { ...p.selection, transcript: false, taskIds: [], speakers: false, timestamps: false }; p.snapshot.segments = []; p.snapshot.transcript = '';
 expect(buildExportBlocks(p).filter(block => block.kind === 'heading').map(block => block.text)).toEqual([p.snapshot.title, 'Reviewed notes']);
});
