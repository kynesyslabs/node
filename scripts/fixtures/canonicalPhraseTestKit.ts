// Shared setup for scripts/validator.test.ts and
// scripts/upgradable-network/cli.test.ts. Both run their script in a child
// process with the SDK's websdk replaced by a fake, so nothing reaches a
// network and no transaction is sent. The fake prints the RPC it was asked to
// connect to, uses the phrase connectWallet received as the address, and
// prints the phrase unstake was called with.
import { afterAll, beforeAll, expect } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FAKE_SDK = `
import { plugin } from "bun"
plugin({
    name: "fake-demosdk-websdk",
    setup(build) {
        build.module("@kynesyslabs/demosdk/websdk", () => ({
            loader: "object",
            exports: {
                Demos: class {
                    wallet = ""
                    async connect(rpc) { console.log("rpc:" + rpc) }
                    async connectWallet(m) { this.wallet = m }
                    getAddress() { return "wallet:" + JSON.stringify(this.wallet) }
                    async getEd25519Address() { return this.getAddress() }
                    async confirm() { return { response: { data: { transaction: { hash: "0xfeed" } } } } }
                    async broadcast() { return { result: 200, extra: { confirmationBlock: 1 } } }
                    async call() { return { state: "included", blockNumber: 1 } }
                },
                DemosTransactions: {
                    stake: async () => ({}),
                    unstake: async demos => {
                        console.log("unstake:" + JSON.stringify(demos.wallet))
                        return {}
                    },
                    validatorExit: async () => ({}),
                },
            },
        }))
    },
})
`

// The public BIP-39 test vector (all-zero entropy), built at run time so the
// secret scanner does not read it as a wallet's phrase.
export const ASCII_PHRASE = [...Array(11).fill("abandon"), "about"].join(" ")
// U+3000 IDEOGRAPHIC SPACE between the words.
export const IDEOGRAPHIC_PHRASE = ASCII_PHRASE.replaceAll(" ", "　")
// The last word in full-width letters.
export const FULL_WIDTH_PHRASE = ASCII_PHRASE.replace(
    /about$/,
    "ａｂｏｕｔ",
)

/** The non-canonical forms a stake command must refuse, with their test names. */
export const NON_CANONICAL_PHRASES: Array<[string, string]> = [
    ["ideographic spaces between the words", IDEOGRAPHIC_PHRASE],
    ["full-width letters", FULL_WIDTH_PHRASE],
]

export interface ScriptRun {
    code: number | null
    stdout: string
    stderr: string
}

const REPO_ROOT = join(import.meta.dir, "..", "..")

/**
 * Makes a temp dir for the calling test file (removed after its tests) and
 * returns helpers that write a phrase file there and run a script from the
 * repo root under the fake SDK.
 */
export function useFakeSdk(prefix: string) {
    let dir = ""
    let preload = ""

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), prefix))
        preload = join(dir, "fake-sdk.ts")
        writeFileSync(preload, FAKE_SDK)
    })

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    return {
        phraseFile(phrase: string): string {
            const file = join(dir, `phrase-${Math.random()}`)
            writeFileSync(file, `${phrase}\n`)
            return file
        },
        run(argv: string[], env: Record<string, string> = {}): ScriptRun {
            const r = Bun.spawnSync(
                [process.execPath, "--preload", preload, ...argv],
                {
                    cwd: REPO_ROOT,
                    env: { ...process.env, ...env },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            )
            return {
                code: r.exitCode,
                stdout: r.stdout.toString(),
                stderr: r.stderr.toString(),
            }
        },
    }
}

/** Exit 1 with the canonical-form message, and none of `absent` on stdout. */
export function expectRefused(r: ScriptRun, absent: string[]): void {
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/^Invalid mnemonic: .*plain lowercase ASCII/)
    for (const text of absent) expect(r.stdout).not.toContain(text)
}

/** No stderr, exit 0, and every one of `present` on stdout. */
export function expectRan(r: ScriptRun, present: string[]): void {
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    for (const text of present) expect(r.stdout).toContain(text)
}
