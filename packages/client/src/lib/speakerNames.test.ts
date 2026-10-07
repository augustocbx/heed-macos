import { expect, test } from "vitest";
import { applySpeakerNames, reconcileSpeakerNames } from "./speakerNames";

test("unmapped reserved names preserve speaker fields and embeddings instead of inherited properties", () => {
 for (const speaker of ["toString", "constructor", "__proto__"]) {
  const segment = { speaker, text: "Speech", start: 0, end: 1, channel: "sys" as const };
  const embeddings = Object.fromEntries([[speaker, [1, 2]]]);
  expect(applySpeakerNames([segment], [speaker], embeddings, {})).toEqual({ segments: [segment], speakers: [speaker], embeddings });
 }
 const segment = { speaker: "Speaker 1", text: "Speech", start: 0, end: 1 };
 expect(applySpeakerNames([segment], ["Speaker 1"], {}, Object.create({ "Speaker 1": "Inherited name" })).segments).toEqual([segment]);
});
test("reserved manual source and target names reconcile and remap embeddings as own entries", () => {
 for (const source of ["toString", "constructor", "__proto__"]) for (const target of ["toString", "constructor", "__proto__"]) {
  const before = [{ speaker: source, text: "Before", start: 0, end: 2, channel: "mic" as const }];
  const after = [{ speaker: target, text: "After", start: 0, end: 2, channel: "mic" as const }];
  const resolved = reconcileSpeakerNames(before, after, Object.fromEntries([[source, source]]));
  expect(Object.hasOwn(resolved, target)).toBe(true); expect(resolved[target]).toBe(source);
  expect(applySpeakerNames(after, [target], Object.fromEntries([[target, [3, 4]]]), resolved)).toEqual({ segments: [{ ...after[0], speaker: source, auto: false }], speakers: [source], embeddings: Object.fromEntries([[source, [3, 4]]]) });
 }
});
test("real conflicting manual names remain unresolved for reserved candidate identities", () => {
 for (const target of ["toString", "constructor", "__proto__"]) {
  const previous = ["Ana", "Bruno"].map(speaker => ({ speaker, text: "Before", start: 0, end: 1, channel: "mic" as const }));
  const final = [{ speaker: target, text: "After", start: 0, end: 1, channel: "mic" as const }];
  const resolved = reconcileSpeakerNames(previous, final, { Ana: "Ana", Bruno: "Bruno" });
  expect(Object.keys(resolved)).toEqual([]); expect(applySpeakerNames(final, [target], {}, resolved).speakers).toEqual([target]);
 }
});
