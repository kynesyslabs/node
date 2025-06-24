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
        // "no-console": "warn",
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
                format: ["camelCase"],
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
}
