import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve(import.meta.dir, "../../..")

// Files that hand the SDK's transaction, block and byte types to the node's
// own (kynesyslabs/node#627). bun build does not type-check, so only this
// keeps them clean.
const FILES = [
    "src/libs/abstraction/web2/boundedFetch.ts",
    "src/libs/blockchain/chainBlocks.ts",
    "src/libs/blockchain/chainTransactions.ts",
    "src/libs/blockchain/gcr/gcr_routines/identityManager.ts",
    "src/libs/blockchain/genesis/genesisBlockContent.ts",
    "src/libs/blockchain/mempool.ts",
    "src/libs/blockchain/routines/findGenesisBlock.ts",
    "src/libs/blockchain/routines/Sync.ts",
    "src/libs/blockchain/routines/syncVerification.ts",
    "src/libs/blockchain/transaction.ts",
    "src/libs/consensus/genesisShardSize.ts",
    "src/libs/consensus/v2/PoRBFT.ts",
    "src/libs/consensus/v2/routines/orderTransactions.ts",
    "src/libs/network/endpointValidation.ts",
    "src/libs/network/handlers/blockHandlers.ts",
    "src/libs/network/routines/nodecalls/getChainIdentity.ts",
    "src/libs/network/routines/nodecalls/getTxsByHashes.ts",
    "src/libs/network/server_rpc.ts",
    "src/libs/peer/routines/peerBootstrap.ts",
    "src/libs/utils/demostdlib/deriveMempoolOperation.ts",
]

// What `tsc --noEmit` reports for `files` under the tsconfig at `root`.
// Declaration-emit diagnostics are left out: tsc reports those only when the
// whole program has no other error, which this repo does not today. Drop
// `declaration: false` once `tsc --noEmit` is clean.
function typeErrors(root: string, files: string[]): string[] {
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")
    if (!configPath) throw new Error("tsconfig.json not found")

    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, declaration: false })

    const diagnostics: string[] = []
    for (const file of files) {
        const source = path.join(root, file)
        const sourceFile = program.getSourceFile(source)
        if (!sourceFile) throw new Error(`${file} not found in tsconfig`)
        for (const diagnostic of ts.getPreEmitDiagnostics(program, sourceFile)) {
            if (diagnostic.file?.fileName !== source) continue
            const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").split("\n")[0]
            diagnostics.push(`${file}:${line + 1}: ${message}`)
        }
    }
    return diagnostics
}

test("SDK type checks run in the consensus suite", () => {
    const script = readFileSync(path.join(ROOT, "scripts/test-consensus.sh"), "utf8")
    const suiteFiles = script.match(/SUITE_FILES=\(([\s\S]*?)\n\)/)?.[1]
    expect(suiteFiles?.split(/\s+/)).toContain("src/libs/blockchain/sdkTypes.typecheck.test.ts")
})

test("the check reports type errors but not declaration-emit errors, as tsc --noEmit does here", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sdk-types-"))
    try {
        writeFileSync(
            path.join(dir, "tsconfig.json"),
            // types: [] keeps the repo's node_modules/@types out of the program.
            JSON.stringify({
                compilerOptions: { declaration: true, strict: true, types: [] },
                files: ["emit.ts", "type.ts"],
            }),
        )
        // TS4094 comes only from declaration emit.
        writeFileSync(path.join(dir, "emit.ts"), "export const C = class { private x = 1 }\n")
        writeFileSync(path.join(dir, "type.ts"), "export const n: number = \"1\"\n")

        expect(typeErrors(dir, ["emit.ts", "type.ts"])).toEqual([
            "type.ts:1: Type 'string' is not assignable to type 'number'.",
        ])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}, 30_000)

test("files using the SDK's transaction and block types have no TypeScript diagnostics", () => {
    expect(typeErrors(ROOT, FILES)).toEqual([])
}, 120_000)
