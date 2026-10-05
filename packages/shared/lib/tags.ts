/** Tag text belongs to the user, independently of the interface language. */
export function normalizeTag(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function tagKey(value: string): string {
  return normalizeTag(value).toLowerCase();
}

export function uniqueTags(values: string[], known: string[] = []): string[] {
  const names = new Map(known.map(name => [tagKey(name), name]));
  const result = new Map<string, string>();
  for (const value of values) {
    const name = normalizeTag(value);
    if (name && !result.has(tagKey(name))) result.set(tagKey(name), names.get(tagKey(name)) ?? name);
  }
  return [...result.values()];
}
