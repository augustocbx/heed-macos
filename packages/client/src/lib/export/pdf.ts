import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { MeetingExportPreview } from '@heed/shared';
import { buildExportBlocks } from './content';
import { assertExportText } from '../../../../shared/lib/export-timing';
import { assertExportSize } from './bounds';

const WIDTH = 595.28, HEIGHT = 841.89, MARGIN = 48, BODY_SIZE = 11;
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
function wrap(measure: (text: string) => number, text: string, width: number): string[] {
 const lines: string[] = [];
 for (const authoredLine of text.replace(/\r\n?/g, '\n').replaceAll('\t', '    ').split('\n')) {
  let line = '';
  for (const { segment } of segmenter.segment(authoredLine)) {
   if (line && measure(line + segment) > width) {
    const space = line.lastIndexOf(' ');
    if (space > 0) { lines.push(line.slice(0, space + 1)); line = line.slice(space + 1); }
    else { lines.push(line); line = ''; }
   }
   // A whole grapheme is indivisible; never clip a font's unusually wide character.
   if (measure(line + segment) > width) throw Error('A text cluster is wider than the PDF page. Use text export.');
   line += segment;
  }
  lines.push(line);
 }
 return lines;
}

export async function renderMeetingPdf(preview: MeetingExportPreview, fonts: { regular: Uint8Array; bold: Uint8Array }): Promise<Uint8Array> {
 assertExportSize(preview);
 const blocks = buildExportBlocks(preview);
 const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
 // Full static fonts avoid subset glyph remapping; output remains independently extractable.
 const regular = await pdf.embedFont(fonts.regular, { subset: false }), bold = await pdf.embedFont(fonts.bold, { subset: false });
 const regularCoverage = new Set(regular.getCharacterSet()), boldCoverage = new Set(bold.getCharacterSet());
 const missing = new Set<string>();
 for (const block of blocks) {
  assertExportText(block.text);
  const coverage = block.kind === 'heading' ? boldCoverage : regularCoverage;
  for (const character of block.text) if (!['\n', '\r', '\t'].includes(character) && !coverage.has(character.codePointAt(0)!)) missing.add(character);
 }
 if (missing.size) throw Error(`PDF font does not support ${[...missing].slice(0, 12).join(' ')}. Use UTF-8 text export for these characters.`);
 pdf.setTitle(preview.snapshot.title); pdf.setAuthor('Heed'); pdf.setCreator('Heed offline meeting export');
 pdf.setSubject(`Accepted source ${preview.snapshot.sourceRevision}; local version ${preview.snapshot.sourceVersion}; generated ${preview.snapshot.generatedAt}`);
 const generated = new Date(preview.snapshot.generatedAt);
 if (Number.isFinite(generated.getTime())) { pdf.setCreationDate(generated); pdf.setModificationDate(generated); }
 let page: PDFPage, y = 0;
 function nextPage(): void {
  if (pdf.getPageCount() >= 2000) throw Error('This PDF exceeds 2,000 pages. Choose a smaller export scope or use text export.');
  page = pdf.addPage([WIDTH, HEIGHT]); y = HEIGHT - MARGIN - 16;
 }
 nextPage();
 const widths = new Map<PDFFont, Map<string, number>>();
 function measured(font: PDFFont, size: number): (text: string) => number {
  const cache = widths.get(font) ?? new Map<string, number>(); widths.set(font, cache);
  return text => {
   const key = `${size}\0${text}`, cached = cache.get(key); if (cached !== undefined) return cached;
   const width = font.widthOfTextAtSize(text, size); if (cache.size < 10_000) cache.set(key, width); return width;
  };
 }
 for (const [index, block] of blocks.entries()) {
  const size = block.kind === 'heading' ? (index === 0 ? 16 : 14) : BODY_SIZE;
  const font = block.kind === 'heading' ? bold : regular, leading = size * 1.35;
  const lines = wrap(measured(font, size), block.text, WIDTH - MARGIN * 2);
  if (block.kind === 'heading' && y - leading * (Math.min(lines.length, 3) + 2) < MARGIN + 16) nextPage();
  // Keep a transcript prefix with its next line rather than orphaning a speaker at the bottom.
  if (block.kind !== 'heading' && lines.length > 1 && y - leading < MARGIN + 16) nextPage();
  for (const line of lines) {
   if (y < MARGIN + 16) nextPage();
   page!.drawText(line, { x: MARGIN, y, size, font, color: block.kind === 'provenance' ? rgb(0.3, 0.3, 0.3) : rgb(0.08, 0.08, 0.08) });
   y -= leading;
  }
  y -= block.kind === 'heading' ? 6 : 10;
 }
 const pages = pdf.getPages();
 for (const [index, item] of pages.entries()) {
  const footer = `Source ${preview.snapshot.sourceRevision.slice(0, 12)} · v${preview.snapshot.sourceVersion} · ${index + 1}/${pages.length}`;
  item.drawText(footer, { x: MARGIN, y: 28, size: 8, font: regular, color: rgb(0.35, 0.35, 0.35) });
 }
 return pdf.save();
}
