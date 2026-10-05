import { expect, test } from "vitest";
import { extractTags, stripTagsFromText } from "./tags";

test("the hashtag shortcut supports accented Unicode words and preserves legacy tags", () => {
  expect(extractTags("Meeting #reunião #équipe #client-followup #reunião")).toEqual(["reunião", "équipe", "client-followup"]);
  expect(stripTagsFromText("Weekly #reunião #client-followup meeting")).toBe("Weekly meeting");
});
