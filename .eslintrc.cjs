module.exports = {
    env: {
        commonjs: true,
        es6: true,
        node: true,
        jest: true,
    },
    globals: {
        NodeJS: "readonly",
        globalThis: "readonly",
    },
    extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
    parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
    },
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint"],
    rules: {
        // indent: ["error", 4, { SwitchCase: 1 }],
        // "linebreak-style": ["error", "unix"],
        quotes: ["error", "double"],
        semi: ["error", "never"],
        // no-console: warn for all src/ files to encourage CategorizedLogger usage
        // Excluded files are defined in overrides below
        "no-console": ["warn", { allow: ["error"] }],
        // no-unused-vars is disabled
        "no-unused-vars": ["off"],
        "no-var": ["off"],
        "@typescript-eslint/no-unused-vars": ["off"],
        "@typescript-eslint/no-var-requires": ["off"],
        "@typescript-eslint/ban-types": ["off"],
        "@typescript-eslint/no-empty-function": ["off"],
        "@typescript-eslint/no-explicit-any": ["off"],
        "switch-colon-spacing": ["error", { after: true, before: false }],
        "no-extra-semi": "error",
        "comma-dangle": ["error", "always-multiline"],
        "no-restricted-imports": ["warn"],
        "@typescript-eslint/naming-convention": [
            "error",
            {
                selector: "variableLike",
                format: ["camelCase", "UPPER_CASE"],
                leadingUnderscore: "allow",
                trailingUnderscore: "allow",
            },
            {
                selector: "function",
                format: ["camelCase"],
            },
            {
                selector: "method",
                format: ["camelCase"],
            },
            {
                selector: "typeLike",
                format: ["PascalCase"],
            },
            {
                selector: "interface",
                format: ["PascalCase"],
                custom: {
                    regex: "^I[A-Z]",
                    match: false,
                },
            },
            {
                selector: "class",
                format: ["PascalCase"],
            },
            {
                selector: "typeAlias",
                format: ["PascalCase"],
            },
        ],
    },
    // Override no-console for files where console.log is acceptable
    overrides: [
        {
            // Standalone CLI tools and utilities where console output is intended
            files: [
                "src/benchmark.ts",
                "src/client/**/*.ts",
                // CLI utilities (both paths)
                "src/utilities/keyMaker.ts",
                "src/utilities/showPubkey.ts",
                "src/utilities/backupAndRestore.ts",
                "src/utilities/commandLine.ts",
                "src/utilities/cli_libraries/**/*.ts",
                "src/utilities/Diagnostic.ts",
                "src/utilities/evmInfo.ts",
                "src/libs/utils/keyMaker.ts",
                "src/libs/utils/showPubkey.ts",
                // TUI components need console access
                "src/utilities/tui/**/*.ts",
                "src/tests/**/*.ts",
            ],
            rules: {
                "no-console": "off",
            },
        },
        {
            // Test files, PoC scripts, and fixture scripts where console output is expected
            files: [
                "tests/**/*.ts",
                "src/tests/**/*.ts",
                "**/test.ts",
                "**/test/*.ts",
                "**/*_test.ts",
                "**/*Test.ts",
                "**/PoC.ts",
                "**/poc.ts",
                "omniprotocol_fixtures_scripts/**/*.ts",
                "local_tests/**/*.ts",
                "aptos_tests/**/*.ts",
            ],
            rules: {
                "no-console": "off",
                "@typescript-eslint/naming-convention": "off",
            },
        },
        {
            // Main entry point startup/shutdown logs are acceptable
            files: ["src/index.ts"],
            rules: {
                "no-console": "off",
            },
        },
    ],
}
