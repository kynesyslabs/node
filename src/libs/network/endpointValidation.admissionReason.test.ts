import { describe, expect, it, mock } from "bun:test"
import { fileURLToPath } from "node:url"
import type { Transaction } from "@kynesyslabs/demosdk/types"

const logged: string[] = []
let reason = ""

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {}, info: () => {}, warning: () => {}, warn: () => {},
        error: (message: unknown) => logged.push(String(message)), only: () => {}, custom: () => {},
    },
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/libs/blockchain/routines/validateTransaction", () => ({
    confirmTransaction: async (tx: Transaction) => ({
        data: { valid: true, reference_block: 100, message: "ok", gas_operation: null, transaction: tx },
        signature: { type: "ed25519", data: "00" },
        rpc_public_key: { type: "ed25519", data: "00" },
    }),
}))
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ sign: async () => ({ signature: new Uint8Array(1) }) }) },
}))
// The edit-binding refusals come from the real module, taken before it is
// mocked below.
const { verifyEditsAgainstBody, verifyNonceEditBinding, verifySenderBinding } = await import(
    "src/libs/blockchain/validation/editBinding"
)
mock.module("src/libs/blockchain/validation/editBinding", () => ({
    editBindingState: async () => ({ active: true }),
    verifyAdmissionEdits: async () => ({ ok: false, reason }),
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { OS, PEER, SENDER, demos, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"
import { blockTxTypeRefusal, nodeMessageRefusal } from "src/libs/blockchain/validation/txTypes"
import { nativeSendRefusal, nonCanonicalAddressRefusal } from "src/libs/blockchain/validation/nativeValueRules"
import { chargedFeeMismatch, shippedFeeMismatch } from "src/libs/blockchain/validation/feeBinding"
import type { FeeBreakdown } from "@/libs/blockchain/routines/calculateCurrentGas"
import { governanceGateRefusal } from "@/forks/governanceGate"
import { L2PS_GATE_REFUSAL } from "@/forks/l2psGate"
import { TLSN_DISABLED_REFUSAL } from "@/forks/tlsnDisabledGate"
import { TOKEN_STAKING_REFUSAL } from "@/forks/tokenStakingGate"

const { handleValidateTransaction } = await import("./endpointValidation")

async function refusedWith(verdict: string): Promise<string> {
    const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
    reason = verdict
    logged.length = 0
    const out = await handleValidateTransaction(tx, SENDER)
    expect(out.data.valid).toBe(false)
    expect(logged.join(" ")).toContain(verdict)
    return out.data.message
}

/** A producer's refusal; a case whose input it accepts proves nothing. */
function refusal(produced: string | null | undefined): string {
    expect(produced).toBeString()
    return produced as string
}

const A = `0x${"a".repeat(64)}`
const B = `0x${"b".repeat(64)}`
const asTx = (content: Record<string, unknown>) => ({ content }) as unknown as Transaction
const send = (args: unknown[], amount = 1) =>
    asTx({ type: "native", from: A, to: B, amount, data: ["native", { nativeOperation: "send", args }] })
const nonceEdit = { type: "nonce", operation: "add", account: A, amount: 1, txhash: "", isRollback: false }
const native = (nonce: number, ...gcr_edits: unknown[]) => asTx({ type: "native", from: A, nonce, gcr_edits })
type Fee = Parameters<typeof chargedFeeMismatch>[0]
const shipped = (network_fee: unknown) => ({ network_fee, rpc_fee: 0, additional_fee: 0 }) as unknown as Fee
const charged = (network_fee: number) => ({ network_fee, rpc_fee: 0, additional_fee: 0 }) as FeeBreakdown

describe("RPC admission reasons", () => {
    it("returns every reason that names a rule or echoes the client's own transaction", async () => {
        for (const verdict of [
            L2PS_GATE_REFUSAL,
            TLSN_DISABLED_REFUSAL,
            TOKEN_STAKING_REFUSAL,
            refusal(blockTxTypeRefusal(asTx({ type: "notAType" }))),
            refusal(blockTxTypeRefusal(asTx({}))),
            refusal(blockTxTypeRefusal(asTx({ type: "a\nb" }))),
            refusal(nodeMessageRefusal(asTx({ type: "instantMessaging", from: A }), new Set())),
            refusal(governanceGateRefusal(asTx({ type: "networkUpgrade" }), false)),
            refusal(governanceGateRefusal(
                asTx({ type: "native", from: A, gcr_edits: [{ type: "networkUpgradeVote", account: A }] }),
                true,
            )),
            refusal(governanceGateRefusal(
                asTx({ type: "networkUpgrade", from: A, gcr_edits: [{ type: "networkUpgrade", account: B }] }),
                true,
            )),
            refusal(nonCanonicalAddressRefusal(asTx({ from: "0xAB" }))),
            refusal(nonCanonicalAddressRefusal(send(["0xAB", 1]))),
            refusal(nonCanonicalAddressRefusal(asTx({ from: A, transaction_fee: { rpc_address: "0xAB" } }))),
            refusal(nonCanonicalAddressRefusal(asTx({ from: A, gcr_edits: [{ type: "balance", account: "0xAB" }] }))),
            refusal(nativeSendRefusal(send([B]), true)),
            refusal(nativeSendRefusal(send([A, 1]), true)),
            refusal(nativeSendRefusal(send([B, 1], 2), true)),
            refusal(chargedFeeMismatch(shipped("1.5"), charged(1), true)),
            refusal(shippedFeeMismatch(shipped("abc"), charged(1))),
            refusal(verifySenderBinding(asTx({ from: A, gcr_edits: [{ ...nonceEdit, account: B }] })).reason),
            refusal(verifySenderBinding(asTx({ from: A, gcr_edits: [{ type: "identity", context: "xm", account: B }] })).reason),
            refusal(verifySenderBinding(asTx({ from: A, gcr_edits: [{ type: "storageProgram", context: { sender: B } }] })).reason),
            refusal((await verifyEditsAgainstBody(asTx({ type: "genesis", gcr_edits: [nonceEdit] }))).reason),
            refusal(verifyNonceEditBinding(asTx({ type: "l2psBatch", gcr_edits: [nonceEdit] })).reason),
            refusal(verifyNonceEditBinding(native(1, nonceEdit, nonceEdit)).reason),
            refusal(verifyNonceEditBinding(native(1, { ...nonceEdit, extra: 1 })).reason),
            refusal(verifyNonceEditBinding(native(1, { ...nonceEdit, amount: 2 })).reason),
            refusal(verifyNonceEditBinding(native(0, nonceEdit)).reason),
            // No pure producer is exported for these. feeBindingRefusal reads
            // gasFeeSeparation at the tip; the award rule is not exported and
            // verifyEditsAgainstBody reaches it through the genesis award
            // signer; the regenerated-set match regenerates the edits; the
            // value-edit projection is not exported.
            "native transaction carries no transaction_fee",
            "transaction_fee names an rpc_address; the sender does not route the rpc share",
            "awardPoints: genesis names no award signer",
            "awardPoints: not signed by the genesis award signer",
            "awardPoints: data carries no account list",
            "awardPoints: 2 edits for 3 resolved accounts",
            "awardPoints: invalid points for 0xabc",
            "awardPoints: edit 0 carries unexpected fields",
            "awardPoints: edit 1 is not the credit its data implies",
            "awardPoints: edit 2 has an invalid or inconsistent date",
            "gcr_edits do not match regenerated set",
            "value edits with no counterpart in the regenerated set (balance|0xabc|add|5)",
        ]) {
            expect(await refusedWith(verdict)).toBe(`GCREdit mismatch: ${verdict}`)
        }
    })

    it("withholds a reason it does not know, keeping it in the log", async () => {
        const notPlusOne = refusal(verifyNonceEditBinding(native(1, { ...nonceEdit, amount: 2 })).reason)
        for (const verdict of [
            "a later rule refused this at node height 1234",
            "gcr_edits do not match regenerated set: 3 regenerated",
            `${TOKEN_STAKING_REFUSAL} since 1234`,
            `${notPlusOne} (account nonce 7)`,
            "awardPoints: invalid points for 0xabc\nprivate state detail",
        ]) {
            expect(await refusedWith(verdict)).toBe("GCREdit mismatch")
        }
    })

    it("returns the category of a reason that carries computed values or internal errors", async () => {
        for (const [verdict, expected] of [
            [refusal(chargedFeeMismatch(shipped(1), charged(9), true)), "transaction_fee mismatch"],
            [refusal(shippedFeeMismatch(shipped(1), charged(9))), "transaction_fee mismatch"],
            [refusal(chargedFeeMismatch(shipped(1), charged(Number.NaN), true)), "transaction_fee mismatch"],
            // Exception text from verifyAdmissionEdits and verifyEditsAgainstBody.
            ["gcr_edits verification error: private state detail", "gcr_edits verification error"],
            ["gcr_edits cannot be regenerated: private state detail", "gcr_edits cannot be regenerated"],
        ]) {
            expect(await refusedWith(verdict)).toBe(`GCREdit mismatch: ${expected}`)
        }
    })
})

describe("RPC admission reasons load order", () => {
    // A gate module reaches endpointValidation through sharedState, so a
    // process that imports the gate first evaluates endpointValidation before
    // the gate's refusal constant exists. Each runs in a fresh process: this
    // file's mocks and module cache would hide the cycle.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
    for (const gate of ["l2psGate", "tlsnDisabledGate", "tokenStakingGate"]) {
        it(`loads when ${gate} is the first project import`, () => {
            const run = Bun.spawnSync(
                [process.execPath, "-e", `await import("./src/forks/${gate}.ts"); console.log("loaded")`],
                { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
            )
            const stderr = run.stderr.toString()
            expect(stderr).not.toContain("ReferenceError")
            expect(run.stdout.toString()).toContain("loaded")
            expect(run.exitCode).toBe(0)
        }, 60_000)
    }
})
