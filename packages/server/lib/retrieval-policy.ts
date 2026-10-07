/** Hard production maxima; callers may reduce limits for constrained workloads and tests. */
const maxima = {
 catalogSources: 20_000, catalogBytes: 16_777_216, sourceRecordBytes: 67_108_864, databaseBytes: 67_108_864, workingDiskBytes: 201_326_592,
 evidenceRows: 250_000, postingRows: 2_000_000, evidenceSlice: 128, queryRows: 100_000, queryMilliseconds: 250,
 queryTerms: 64, queryCharacters: 2_000, queryBytes: 8_000, candidateHits: 64, globalHits: 48, sourceWinners: 16,
 anchors: 16, excerpts: 32, fallbackSources: 4, fallbackEvidence: 256, fallbackSourceBytes: 67_108_864,
 cacheEntries: 32, cacheBytes: 1_048_576, cacheTTLMilliseconds: 60_000, sqliteCacheKiB: 4096,
 generationCalls: 4, generationInputBytes: 5_500, generationContextTokens: 8_192,
} as const;
export type RetrievalPolicy = { readonly [Key in keyof typeof maxima]: number };
export function createRetrievalPolicy(overrides: Partial<RetrievalPolicy> = {}): RetrievalPolicy {
 const policy = { ...maxima, ...overrides };
 for (const key of Object.keys(overrides)) if (!Object.hasOwn(maxima, key)) throw new Error("Unknown retrieval policy dimension");
 for (const key of Object.keys(maxima) as Array<keyof RetrievalPolicy>) if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > maxima[key]) throw new Error(`Invalid retrieval policy: ${key}`);
 if (policy.globalHits + policy.sourceWinners > policy.candidateHits || policy.anchors > policy.candidateHits || policy.excerpts < policy.anchors || policy.databaseBytes < 4096 || policy.workingDiskBytes < policy.databaseBytes) throw new Error("Inconsistent retrieval policy allocation");
 return Object.freeze(policy);
}
export const defaultRetrievalPolicy = createRetrievalPolicy();
