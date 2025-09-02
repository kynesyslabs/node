import js from "@eslint/js"
import typescript from "@typescript-eslint/eslint-plugin"
import typescriptParser from "@typescript-eslint/parser"

export default [
    js.configs.recommended,
    {
        files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        languageOptions: {
            parser: typescriptParser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: "module",
            },
            globals: {
                NodeJS: "readonly",
                globalThis: "readonly",
                console: "readonly",
                process: "readonly",
                Buffer: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                module: "readonly",
                require: "readonly",
                exports: "readonly",
                global: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                // Bun globals
                Bun: "readonly",
                // Node.js/Web globals  
                crypto: "readonly",
                fetch: "readonly",
                structuredClone: "readonly",
                Timer: "readonly",
                // Web API globals
                WebSocket: "readonly",
                Response: "readonly",
                Request: "readonly",
                URL: "readonly",
                Headers: "readonly",
                TextEncoder: "readonly",
                TextDecoder: "readonly",
            },
        },
        plugins: {
            "@typescript-eslint": typescript,
        },
        rules: {
            // Basic rules
            "quotes": ["error", "double"],
            "semi": ["error", "never"],
            "no-unused-vars": "off",
            "no-var": "off",
            "switch-colon-spacing": ["error", { after: true, before: false }],
            "no-extra-semi": "error",
            "comma-dangle": ["error", "always-multiline"],
            "no-restricted-imports": ["warn"],
            
            // TypeScript rules
            "@typescript-eslint/no-unused-vars": "off",
            "@typescript-eslint/no-var-requires": "off",
            "@typescript-eslint/ban-types": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-explicit-any": "off",
            // Naming convention requires TypeScript parser services - keeping disabled for now
            // You can enable it per-file basis or with specific TypeScript config if needed
            // "@typescript-eslint/naming-convention": ["error", {...}],
        },
    },
    {
        ignores: [
            "node_modules/**",
            "diagrams/**",
            "data/**",
            "dist/**",
            ".github/**",
            ".vscode/**",
            "postgres_*",
            "aptos_examples_ts/**",
            // Exclude external smart contract libraries
            "src/features/bridges/EVMSmartContract/lib/**",
            "src/features/bridges/EVMSmartContract/contracts/**",
            // Exclude Solana program tests (external)
            "src/features/bridges/SolanaTankProgram/**",
        ],
    },
]