module.exports = {
    env: {
        commonjs: true,
        es6: true,
        node: true,
    },
    globals: {
        NodeJS: "readonly",
    },
    extends: "eslint:recommended",
    parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
    },
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint"],
    rules: {
        // indent: ["error", 4, { SwitchCase: 1 }],
        "linebreak-style": ["error", "unix"],
        quotes: ["error", "double"],
        semi: ["error", "never"],
        // "no-console": "warn",
        "no-unused-vars": ["warn"],
        "switch-colon-spacing": ["error", { after: true, before: false }],
        "no-extra-semi": "error",
        "comma-dangle": ["error", "always-multiline"],
        "no-restricted-imports": ["warn"],
    },
}
