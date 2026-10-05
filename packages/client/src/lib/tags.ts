/**
 * Tag extraction from titles using #hashtag syntax.
 */
export function extractTags(text: string): string[] {
	const matches = text.matchAll(/#([\w-]+)/g);
	const tags: string[] = [];
	for (const m of matches) tags.push(m[1].toLowerCase());
	return [...new Set(tags)];
}

export function stripTagsFromText(text: string): string {
	return text.replace(/#[\w-]+/g, "").replace(/\s+/g, " ").trim();
}
