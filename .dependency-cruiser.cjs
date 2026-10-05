/**
 * Architecture boundary enforcement (dependency-cruiser). Two rules that are cheap and high-value
 * for this monorepo (per the Bun/monorepo research): catch dependency CYCLES, and keep @heed/shared
 * a pure LEAF (it must import nothing internal, so splitting the server God file stays safe).
 *
 * Run: `bunx depcruise packages --config .dependency-cruiser.cjs`
 * Diagram: `bunx depcruise packages --config .dependency-cruiser.cjs --output-type dot | dot -Tsvg > arch.svg`
 */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment: "Circular dependencies make modules impossible to reason about or test in isolation.",
			from: {},
			to: { circular: true },
		},
		{
			name: "shared-is-leaf",
			severity: "error",
			comment: "@heed/shared must stay a pure leaf — types + tiny pure helpers, no internal imports.",
			from: { path: "packages/shared" },
			to: { path: "packages/(client|server|cli|transcription)" },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: { path: "node_modules|\\.test\\.|dist|\\.build" },
		tsConfig: { fileName: "packages/client/tsconfig.json" },
		enhancedResolveOptions: { extensions: [".ts", ".tsx", ".js", ".jsx"] },
	},
};
