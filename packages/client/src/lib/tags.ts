import { uniqueTags } from "@heed/shared";
/**
 * Tag extraction from titles using #hashtag syntax.
 */
export function extractTags(text: string): string[] {
	const matches = text.matchAll(/#([\p{L}\p{M}\p{N}_-]+)/gu);
	const tags: string[] = [];
	for (const m of matches) tags.push(m[1].toLowerCase());
	return uniqueTags(tags);
}

export function stripTagsFromText(text: string): string {
	return text.replace(/#[\p{L}\p{M}\p{N}_-]+/gu, "").replace(/\s+/g, " ").trim();
}
