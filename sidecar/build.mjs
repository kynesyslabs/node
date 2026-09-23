import { build } from "esbuild"

await build({
    entryPoints: ["src/index.js"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: "dist/gossip-sidecar.mjs",
    banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    logLevel: "info",
})
