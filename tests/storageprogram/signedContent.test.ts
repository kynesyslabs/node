import "./mockDatasource"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import _ from "lodash"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { UnifiedCrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

// Loaded after the datasource stub is registered
const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { default: Transaction } = await import("@/libs/blockchain/transaction")
const { default: Hashing } = await import("@/libs/crypto/hashing")
const { default: Chain } = await import("@/libs/blockchain/chain")
const { default: Mempool } = await import("@/libs/blockchain/mempool_v2")
const { default: ServerHandlers } = await import("@/libs/network/endpointHandlers")

const SENDER = "a".repeat(64)
const TIMESTAMP = 1_700_000_000_000

/** Builds a storageProgram tx the way a client does: edits from the SDK, then hash = sha256(content) */
async function buildSignedTx(payload: any, extraEdits: any[] = []) {
    const content: any = {
        type: "storageProgram",
        from: SENDER,
        from_ed25519_address: SENDER,
        to: payload.storageAddress,
        amount: 0,
        data: ["storageProgram", payload],
        gcr_edits: [],
        nonce: 1,
        timestamp: TIMESTAMP,
        transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0 },
    }
    const clientEdits = await GCRGeneration.generate({ content, hash: "" } as any)
    clientEdits.forEach((edit: any) => (edit.txhash = ""))
    content.gcr_edits = [...clientEdits, ...extraEdits]
    return {
        content,
        hash: Hashing.sha256(JSON.stringify(content)),
        signature: { type: "ed25519", data: "00" },
        ed25519_signature: "",
        status: "pending",
        blockNumber: 5,
    } as any
}

const createPayload = () =>
    StorageProgram.createStorageProgram(SENDER, "app", { k: "v" }, "public", "s")

const spies: { mockRestore: () => void }[] = []
afterEach(() => {
    spies.splice(0).forEach(spy => spy.mockRestore())
})

describe("storage edits are derived, signed content is untouched (findings 1 and 4)", () => {
    test("SDK 2.4.24 client edits for a storageProgram tx are exactly gas + nonce", async () => {
        const tx = await buildSignedTx(createPayload())
        expect(tx.content.gcr_edits.map((e: any) => e.type)).toEqual(["balance", "nonce"])
    })

    test("getTxEdits keeps gas + nonce, appends the derived storage edit, and leaves the tx coherent", async () => {
        const tx = await buildSignedTx(createPayload())
        const before = _.cloneDeep(tx)
        const result = await HandleGCR.getTxEdits(tx)

        expect(result.success).toBe(true)
        expect(result.edits.map((e: any) => e.type)).toEqual(["balance", "nonce", "storageProgram"])
        expect(result.edits[2]).toMatchObject({
            target: createPayload().storageAddress,
            txhash: tx.hash,
            context: { operation: "CREATE", sender: SENDER },
        })
        expect(tx).toEqual(before)
        expect(Transaction.isCoherent(tx)).toBe(true)
    })

    test("derived storage edit is deterministic (no wall-clock time)", async () => {
        const tx = await buildSignedTx(createPayload())
        const first = await HandleGCR.getTxEdits(tx)
        await new Promise(resolve => setTimeout(resolve, 5))
        const second = await HandleGCR.getTxEdits(tx)
        expect(second.edits).toEqual(first.edits)
        expect((first.edits[2] as any).context.data.metadata.created).toBe(TIMESTAMP)
    })

    test("client-supplied storageProgram edits are rejected", async () => {
        const forged = {
            type: "storageProgram",
            target: "stor-" + "9".repeat(40),
            isRollback: false,
            txhash: "",
            context: { operation: "DELETE", sender: "b".repeat(64) },
        }
        const tx = await buildSignedTx(createPayload(), [forged])
        const result = await HandleGCR.getTxEdits(tx)
        expect(result.success).toBe(false)
    })

    test("applyToTx applies gas, nonce and the storage edit", async () => {
        const tx = await buildSignedTx(createPayload())
        spies.push(spyOn(Chain, "checkTxExists").mockResolvedValue(false))
        const applied: string[] = []
        spies.push(
            spyOn(HandleGCR, "apply").mockImplementation(async (edit: any) => {
                applied.push(edit.type)
                return { success: true, message: "" }
            }),
        )
        const result = await HandleGCR.applyToTx(tx, false, true)
        expect(result.success).toBe(true)
        expect(applied).toEqual(["balance", "nonce", "storageProgram"])
    })

    test("handleExecuteTransaction puts the tx in the mempool unchanged and coherent", async () => {
        const tx = await buildSignedTx(createPayload())
        const nodeKey = new Uint8Array(32).fill(7)
        spies.push(
            // ucrypto is a proxy over the UnifiedCrypto instance, so stub the prototype
            spyOn(UnifiedCrypto.prototype, "getIdentity").mockResolvedValue({ publicKey: nodeKey } as any),
            spyOn(UnifiedCrypto.prototype, "verify").mockResolvedValue(true),
            spyOn(Chain, "getLastBlockNumber").mockResolvedValue(5),
            spyOn(HandleGCR, "applyToTx").mockResolvedValue({ success: true, message: "" }),
        )
        let mempoolTx: any = null
        spies.push(
            spyOn(Mempool, "addTransaction").mockImplementation(async (t: any) => {
                mempoolTx = t
                return { confirmationBlock: 6, error: null } as any
            }),
        )

        const validityData: any = {
            data: {
                valid: true,
                reference_block: 5,
                message: "",
                gas_operation: null,
                transaction: _.cloneDeep(tx),
            },
            signature: { type: "ed25519", data: "00" },
            rpc_public_key: { type: "ed25519", data: uint8ArrayToHex(nodeKey) },
        }

        const result = await ServerHandlers.handleExecuteTransaction(validityData, SENDER)
        expect(result.success).toBe(true)
        expect(mempoolTx).not.toBeNull()
        expect(mempoolTx.content).toEqual(tx.content)
        expect(mempoolTx.content.gcr_edits.map((e: any) => e.type)).toEqual(["balance", "nonce"])
        expect(Transaction.isCoherent(mempoolTx)).toBe(true)
    })
})
