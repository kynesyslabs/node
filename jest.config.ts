import { pathsToModuleNameMapper } from "ts-jest"

import type { JestConfigWithTsJest } from "ts-jest"

const jestConfig: JestConfigWithTsJest = {
	moduleNameMapper: pathsToModuleNameMapper({
		// SEE: tsconfig.json > compilerOptions > paths
        // INFO: When you define paths in tsconfig, also define here
        // TODO: Find a way to avoid the double work
		// "$lib/*": ["src/lib/*"],
	}),
	preset: "ts-jest",
	roots: ["<rootDir>"],
	modulePaths: ["./"],
	transform: { "^.+\\.(t|j)s?$": ["ts-jest", { isolatedModules: true }] },

	// INFO: Tests involving ledger lookups need this
	testTimeout: 20_000,
}

export default jestConfig
