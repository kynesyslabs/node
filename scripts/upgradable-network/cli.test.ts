import { describe, it } from "bun:test"
import {
    ASCII_PHRASE,
    IDEOGRAPHIC_PHRASE,
    NON_CANONICAL_PHRASES,
    expectRan,
    expectRefused,
    useFakeSdk,
} from "../fixtures/canonicalPhraseTestKit"

// Runs scripts/upgradable-network/cli.ts under the fake SDK of
// scripts/fixtures/canonicalPhraseTestKit.ts, which prints the RPC it was
// asked to connect to and uses the phrase connectWallet received as the
// address.
const sdk = useFakeSdk("upgradable-cli-")

function run(command: string, phrase: string) {
    return sdk.run(["scripts/upgradable-network/cli.ts", command], {
        MNEMONIC_FILE: sdk.phraseFile(phrase),
        RPC_URL: "http://fake.invalid",
    })
}

describe("scripts/upgradable-network/cli.ts canonical phrase", () => {
    it("stakes with a canonical ASCII phrase", () => {
        expectRan(run("stake", ASCII_PHRASE), [
            "rpc:http://fake.invalid",
            `from wallet:${JSON.stringify(ASCII_PHRASE)}`,
        ])
    })

    for (const [form, phrase] of NON_CANONICAL_PHRASES) {
        it(`refuses to stake with ${form}, before connecting`, () => {
            expectRefused(run("stake", phrase), ["rpc:", "staking"])
        })
    }

    // Only stake is guarded: a stake made under the key of a non-canonical
    // phrase must stay unstakeable, so unstake passes the raw phrase through.
    it("still unstakes with a non-canonical phrase", () => {
        expectRan(run("unstake", IDEOGRAPHIC_PHRASE), [
            `unstake:${JSON.stringify(IDEOGRAPHIC_PHRASE)}`,
        ])
    })
})
