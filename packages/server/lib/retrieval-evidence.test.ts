import { expect, test } from "bun:test";
import type { Session } from "../../shared/types/session";
import * as chat from "./meeting-chat";

function iterate(session: Session) {
 const fn = (chat as any).iterateTranscriptEvidence;
 expect(typeof fn).toBe("function");
 return fn(session) as IterableIterator<any>;
}
const source = (fields: Partial<Session>) => ({ id: "meeting", transcript: "", language: "pt", speakers: [], segments: [], ...fields }) as Session;

test("lazy accepted evidence retains the existing segmented citation bytes", () => {
 const session = source({ transcript: "Ação", speakers: ["Ana"], segments: [{ speaker: "Ana", text: "Ação", start: 0, end: 1, channel: "mic" }] });
 const hash = "591db66f5f22ac7e0a455c2e672c55e8ba0511efdf80ebb8bf456672051deb9c";
 expect([...iterate(session)]).toEqual([{ id: `meeting:${hash}:0:0`, sessionId: "meeting", sourceRevision: hash, segmentIndex: 0, paragraphIndex: null, speaker: "Ana", quote: "Ação", start: 0, end: 1 }]);
});
test("untimed paragraph indices and greedy blank-line splitting stay compatible", () => {
 const session = source({ transcript: "Ação\n\n  \n\nSecond" });
 const hash = "66ade3d5889912e7c8294e93414c874df69bb6e8112f5860c95933c8414a3d78";
 expect([...iterate(session)]).toEqual(["Ação", "Second"].map((quote, index) => ({ id: `meeting:${hash}:${index}:0`, sessionId: "meeting", sourceRevision: hash, segmentIndex: null, paragraphIndex: index, speaker: "", quote, start: null, end: null })));
});
test("oversized chunks preserve UTF-16 offsets including a split surrogate pair", () => {
 const session = source({ transcript: "a".repeat(1199) + "😀tail" });
 const values = [...iterate(session)];
 expect(values).toHaveLength(2); expect(values[0].quote).toBe("a".repeat(1199) + "\ud83d"); expect(values[1].quote).toBe("\ude00tail");
 expect(values[0].id.endsWith(":0:0")).toBe(true); expect(values[1].id.endsWith(":0:1200")).toBe(true);
 expect(chat.transcriptEvidence(session)).toEqual(values);
});
test("iterator yields one evidence item without reading later segment text", () => {
 let laterReads = 0;
 const later = { speaker: "Later", start: 1, end: 2, get text() { laterReads++; return "Later"; } };
 // Source hashing reads all text once; iteration must not make an eager second pass.
 const session = source({ segments: [{ speaker: "First", text: "First", start: 0, end: 1 }, later] });
 const iterator = iterate(session); expect(iterator.next().value.quote).toBe("First"); expect(laterReads).toBe(1);
 expect(iterator.next().value.quote).toBe("Later"); expect(laterReads).toBe(2);
});
test("only current accepted nonempty text contributes evidence and invalid timings stay null", () => {
 const session = source({ transcript: "accepted", segments: [{ speaker: "Ana", text: " ", start: 0, end: 1 }, { speaker: "Ana", text: "Accepted", start: -1, end: NaN }], transcriptEditing: { candidates: [{ transcript: "Candidate" }], generations: [{ transcript: "History" }] } as any });
 const values = [...iterate(session)]; expect(values).toHaveLength(1); expect(values[0]).toMatchObject({ quote: "Accepted", segmentIndex: 1, start: null, end: null });
 expect([...iterate(source({ transcript: " \n\n " }))]).toEqual([]);
});
test("speaker and timing corrections produce current source-qualified evidence", () => {
 const first = source({ segments: [{ speaker: "Ana", text: "Decision", start: 0, end: 1 }] });
 const original = [...iterate(first)][0]; const corrected = [...iterate({ ...first, segments: [{ ...first.segments[0]!, speaker: "Maria", start: 0.2 }] })][0];
 expect(corrected.id).not.toBe(original.id); expect(corrected).toMatchObject({ quote: "Decision", speaker: "Maria", start: 0.2, end: 1 });
});
