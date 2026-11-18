/**
 * RPC intake queues only a transaction the tx topic can carry. Every staked
 * peer refuses a tx message over TXS_MAX_BYTES, so a transaction queued
 * anyway reached a block only while this node sat in the committee, and
 * otherwise left the pool unannounced once its reference block expired, the
 * same symptom as #973. A storage program create or write is the transaction
 * a client can make that large within the node's own size limit, since it
 * carries its data twice. A node with gossip off reaches peers only through
 * the merge, whatever the size, so it queues as before. The SDK signer is the
 * real one; the chain, the pool and the gossip mesh are replaced.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

import { captureQueued, installSubmissionMocks } from "./txSubmission.fixtures"
import { mockLogger } from "src/libs/blockchain/testSupport/mockMempoolDeps"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import { SENDER, chainIs, handMade, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"
import { validateStorageProgramPayload } from "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import { TXS_MAX_BYTES } from "src/libs/gossip/topics"

mockLogger("src/utilities/logger")
installSubmissionMocks()

// A publish is fire and forget: the mesh takes it whatever the receivers do.
let gossipOn = true
mock.module("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: {
        isEnabled: () => gossipOn,
        getInstance: () => ({ publishTx: async () => true }),
    },
}))
beforeEach(() => {
    gossipOn = true
})

const { gossipSizeRefusal, submitValidatedTx } = await import("./txSubmission")

const queued = captureQueued(Mempool)

/** The ValidityData a confirm returns for `tx`: what is broadcast and then gossiped. */
const envelope = (tx: Transaction) =>
    ({
        data: { valid: true, reference_block: 100, message: "", gas_operation: null, transaction: tx },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: "aa".repeat(32) },
    }) as unknown as ValidityData

/** The message bytes a publish of `vd` puts on the tx topic. */
const onTheTopic = (vd: unknown) => new TextEncoder().encode(JSON.stringify(vd))

async function createProgram(data: Record<string, unknown> | string, encoding: "json" | "binary" = "json") {
    const payload = StorageProgram.createStorageProgram(
        SENDER,
        "listing",
        data,
        encoding,
        StorageProgram.publicACL(),
        { nonce: 8 },
    )
    // Within the size the node applies.
    expect(validateStorageProgramPayload(payload, SENDER).valid).toBe(true)
    const tx = onTheWire(await handMade("storageProgram", payload, payload.storageAddress))
    return { tx, vd: envelope(tx) }
}

describe("RPC submission of a storage program, by its size on the tx topic", () => {
    for (const editBinding of [null, 0]) {
        const label = editBinding === null ? "editBinding dormant" : "editBinding active"

        it(`refuses one no peer would ingest instead of queueing it (${label})`, async () => {
            chainIs(true, editBinding)
            const { tx, vd } = await createProgram({ blob: "x".repeat(150_000) })
            expect(onTheTopic(vd).length).toBeGreaterThan(TXS_MAX_BYTES)
            const out = await submitValidatedTx(vd, tx)
            expect(out.ok).toBe(false)
            expect(out.error).toContain(`${TXS_MAX_BYTES}`)
            expect(queued.hashes).toEqual([])
        })

        it(`queues one the tx topic carries (${label})`, async () => {
            chainIs(true, editBinding)
            const { tx, vd } = await createProgram({ listing: "dacs" })
            expect(onTheTopic(vd).length).toBeLessThanOrEqual(TXS_MAX_BYTES)

            expect(await submitValidatedTx(vd, tx)).toMatchObject({ ok: true, published: true })
            expect(queued.hashes).toEqual([tx.hash])
        })
    }

    it("queues a large one on a node with gossip off, as before", async () => {
        chainIs(true, null)
        gossipOn = false
        const { tx, vd } = await createProgram({ blob: "x".repeat(150_000) })
        expect(onTheTopic(vd).length).toBeGreaterThan(TXS_MAX_BYTES)

        expect(await submitValidatedTx(vd, tx)).toMatchObject({ ok: true, published: false })
        expect(queued.hashes).toEqual([tx.hash])
    })

    // The bound the runbook gives for getStorageProgramLimits: binary data is
    // carried as base64, twice, so it fits less than json data does.
    it("carries about 127 KiB of json data, or about 95 KiB of binary data, in one create", async () => {
        chainIs(true, null)
        // {"blob":"…"} is 11 bytes around the string.
        const json = (kib: number) => createProgram({ blob: "x".repeat(kib * 1024 - 11) })
        const binary = (kib: number) => createProgram(Buffer.alloc(kib * 1024, 7).toString("base64"), "binary")
        const outcomes: Record<string, boolean> = {}
        for (const [name, make] of [
            ["json 126 KiB", () => json(126)],
            ["json 128 KiB", () => json(128)],
            ["binary 94 KiB", () => binary(94)],
            ["binary 96 KiB", () => binary(96)],
        ] as const) {
            const { tx, vd } = await make()
            outcomes[name] = (await submitValidatedTx(vd, tx)).ok
        }
        expect(outcomes).toEqual({
            "json 126 KiB": true,
            "json 128 KiB": false,
            "binary 94 KiB": true,
            "binary 96 KiB": false,
        })
    })

    it("measures the envelope as the topic validator does, up to the byte", () => {
        // {"p":"…"} is 8 bytes around the padding.
        const atCap = { p: "x".repeat(TXS_MAX_BYTES - 8) }
        expect(onTheTopic(atCap).length).toBe(TXS_MAX_BYTES)
        expect(gossipSizeRefusal(atCap as unknown as ValidityData)).toBeNull()
        const overCap = { p: "é".repeat(1) + "x".repeat(TXS_MAX_BYTES - 9) }
        expect(onTheTopic(overCap).length).toBe(TXS_MAX_BYTES + 1)
        expect(gossipSizeRefusal(overCap as unknown as ValidityData)).toContain(`${TXS_MAX_BYTES}`)
    })
})
