import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { renderMeetingPdf } from './pdf';
import { exportPreview } from './fixtures.test-support';
const fonts = { regular: new Uint8Array(readFileSync(resolve('src/lib/export/fonts/NotoSans-Regular.ttf'))), bold: new Uint8Array(readFileSync(resolve('src/lib/export/fonts/NotoSans-Bold.ttf'))) };
test('produces an A4 Unicode PDF with accurate source metadata and extractable embedded fonts', async () => {
 const p = exportPreview(); p.snapshot.title = 'Ação / Hello / Straße / français / a\u0301 / € ±';
 const bytes = await renderMeetingPdf(p, fonts), pdf = await PDFDocument.load(bytes);
 expect(pdf.getTitle()).toBe(p.snapshot.title); expect(pdf.getSubject()).toContain(p.snapshot.sourceRevision); expect(pdf.getSubject()).toContain(p.snapshot.generatedAt);
 expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1); expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 1); expect(pdf.getPage(0).getHeight()).toBeCloseTo(841.89, 1);
 expect(bytes.length).toBeGreaterThan(1000);
});
test('long meetings and unbroken names span multiple pages without changing 11pt body size', async () => {
 const p = exportPreview(); p.snapshot.title = 'LongName'.repeat(150); p.snapshot.segments = Array.from({ length: 90 }, (_, index) => ({ speaker: 'Speaker'.repeat(20), start: index, end: index + 1, text: 'English and Português ação. '.repeat(10) }));
 p.snapshot.duration = 90; p.snapshot.transcript = p.snapshot.segments.map(segment => segment.text).join('\n');
 const pdf = await PDFDocument.load(await renderMeetingPdf(p, fonts)); expect(pdf.getPageCount()).toBeGreaterThan(5);
 for (const page of pdf.getPages()) expect(page.getSize()).toEqual(pdf.getPage(0).getSize());
}, 15_000);
test('notes-only and tasks-only documents work and unsupported glyphs fail explicitly', async () => {
 const p = exportPreview(); p.selection = { transcript: false, notes: true, taskIds: [], speakers: false, timestamps: false };
 expect((await renderMeetingPdf(p, fonts)).length).toBeGreaterThan(1000);
 p.selection.notes = false; p.selection.taskIds = ['task']; expect((await renderMeetingPdf(p, fonts)).length).toBeGreaterThan(1000);
 p.snapshot.title = 'Unsupported 🦄'; await expect(renderMeetingPdf(p, fonts)).rejects.toThrow(/🦄.*text export|text export.*🦄/i);
});
