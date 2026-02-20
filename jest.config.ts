import { pathsToModuleNameMapper } from "ts-jest"

import type { JestConfigWithTsJest } from "ts-jest"

const pathAliases = pathsToModuleNameMapper(
    {
        // SEE: tsconfig.json > compilerOptions > paths
        // INFO: When you define paths in tsconfig, also define here,
        // "$lib/*": ["src/lib/*"],
        // TODO: Find a way to avoid the double work
        "@/*": ["src/*"],
    },
    { prefix: "<rootDir>/" },
)

const jestConfig: JestConfigWithTsJest = {
    moduleNameMapper: {
        ...pathAliases,
        "^@kynesyslabs/demosdk/encryption$":
            "<rootDir>/tests/mocks/demosdk-encryption.ts",
        "^@kynesyslabs/demosdk/types$":
            "<rootDir>/tests/mocks/demosdk-types.ts",
        "^@kynesyslabs/demosdk/websdk$":
            "<rootDir>/tests/mocks/demosdk-websdk.ts",
        "^@kynesyslabs/demosdk/xm-localsdk$":
            "<rootDir>/tests/mocks/demosdk-xm-localsdk.ts",
        "^@kynesyslabs/demosdk/abstraction$":
            "<rootDir>/tests/mocks/demosdk-abstraction.ts",
        "^@kynesyslabs/demosdk/build/.*$":
            "<rootDir>/tests/mocks/demosdk-build.ts",
        "^@kynesyslabs/demosdk$":
            "<rootDir>/tests/mocks/demosdk-types.ts",
    },
    preset: "ts-jest",
    roots: ["<rootDir>"],
    modulePaths: ["./"],
    transform: { "^.+\\.(t|j)s?$": ["ts-jest", { isolatedModules: true }] },

    // INFO: Tests involving ledger lookups need this
    testTimeout: 20_000,
}

export default jestConfig
