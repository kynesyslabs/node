/**
 * A PQC-only tx is valid only while its signer's identity record exists.
 * Admission judged it against the record as it stood then; if a `pqcremove`
 * lands in block N-1, a forger that still put the tx into block N would
 * apply it while every node syncing N refuses it. The forger therefore runs
 * the check Sync runs, on the state block N is built on, and leaves it out.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn(), only: jest.fn(), custom: jest.fn() },
}))

mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonces: jest.fn(async (accounts: string[]) =>
            Object.fromEntries(accounts.map(a => [a, 7])),
        ),
    },
}))

// The identity rows of the state the block is built on.
let identityRows: Array<{ pubkey: string; identities: unknown }> = []
const datasource = {
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({ getRepository: () => ({ find: async () => identityRows }) }),
        }),
    },
}
mock.module("@/model/datasource", () => datasource)
mock.module("src/model/datasource", () => datasource)

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { ErrorCode } from "@/errors"
import { verifyBlockTxSignatures } from "@/libs/blockchain/validation/verifyBlockTxSignatures"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import { judgeBlockTransactions } from "./blockTransactions"

const HEIGHT = 101
const PEER = "0x" + "cd".repeat(32)

function offline(demos: any): void {
    demos.getAddressNonce = async () => 7
    demos._isPostForkCached = async () => true
    demos._assertAmountAcceptableOnTargetNode = async () => {}
    demos._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 0 })
    demos._chainIdCached = async () => "devnet"
    demos._isSignatureDomainActiveCached = async () => false
}

const pqc: any = new Demos()
await pqc.connectWalletFromPrivateKey("0x" + "22".repeat(32), { algorithm: "falcon" })
offline(pqc)
const ed: any = new Demos()
await ed.connectWalletFromPrivateKey("0x" + "33".repeat(32), { algorithm: "ed25519" })
offline(ed)

const pqcAddress: string = pqc.getAddress()
const { publicKey: edKey } = await pqc.crypto.getIdentity("ed25519")
const owner = uint8ArrayToHex(edKey)
const binding = await pqc.crypto.sign("ed25519", new TextEncoder().encode(pqcAddress))

/** The record `pqcadd` stores; `pqcremove` deletes it. */
const linkedRow = {
    pubkey: owner,
    identities: { pqc: { falcon: [{ address: pqcAddress, signature: uint8ArrayToHex(binding.signature) }] } },
}

const inPool = (tx: any) => ({ ...JSON.parse(JSON.stringify(tx)), reference_block: 100, status: "pending" })

const savedState = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
}

beforeEach(() => {
    const forks = cloneDefaultForkConfig()
    forks.osDenomination.activationHeight = 0
    forks.signatureDomain.activationHeight = null
    getSharedState.forkConfig = forks
    getSharedState.lastBlockNumber = HEIGHT - 1
})

afterEach(() => {
    Object.assign(getSharedState, savedState)
})

describe("a PQC-only tx whose key was removed in block N-1", () => {
    it("is signed by the PQC key alone", async () => {
        const tx = await DemosTransactions.pay(PEER, 1n, pqc)
        expect(tx.signature.type).toBe("falcon")
        expect(tx.ed25519_signature ?? null).toBeNull()
    })

    it("is left out of block N, and the ed25519 tx beside it stays", async () => {
        const pqcTx = inPool(await DemosTransactions.pay(PEER, 1n, pqc))
        const edTx = inPool(await DemosTransactions.pay(PEER, 1n, ed))
        identityRows = []

        const judged = await judgeBlockTransactions([pqcTx, edTx], HEIGHT, {
            capped: false,
            osDenominationActive: true,
        })

        expect(judged.txs.map(t => t.hash)).toEqual([edTx.hash])
        expect(judged.failedTxs).toEqual([
            expect.objectContaining({ txhash: pqcTx.hash, code: ErrorCode.VALIDATION_TX_INVALID }),
        ])
    })

    it("is refused the same way by the check a syncing node runs", async () => {
        const pqcTx = inPool(await DemosTransactions.pay(PEER, 1n, pqc))
        const block = { number: HEIGHT, content: { ordered_transactions: [pqcTx.hash] } } as any

        identityRows = []
        expect((await verifyBlockTxSignatures(block, [pqcTx])).valid).toBe(false)
        identityRows = [linkedRow]
        expect((await verifyBlockTxSignatures(block, [pqcTx])).valid).toBe(true)
    })

    it("enters block N while the key is still linked", async () => {
        const pqcTx = inPool(await DemosTransactions.pay(PEER, 1n, pqc))
        identityRows = [linkedRow]

        const judged = await judgeBlockTransactions([pqcTx], HEIGHT, {
            capped: false,
            osDenominationActive: true,
        })

        expect(judged.txs.map(t => t.hash)).toEqual([pqcTx.hash])
        expect(judged.failedTxs).toEqual([])
    })
})

describe("a PQC-only tx the validator could not judge", () => {
    it("is left out of block N without being failed, so it waits for the next block", async () => {
        const pqcTx = inPool(await DemosTransactions.pay(PEER, 1n, pqc))
        identityRows = [linkedRow]
        const validate = spyOn(TxValidatorPool.getInstance(), "validate").mockResolvedValue([
            { hash: pqcTx.hash, valid: false, undecided: true, reason: "validator pool error: worker timed out" },
        ] as any)
        try {
            const judged = await judgeBlockTransactions([pqcTx], HEIGHT, {
                capped: false,
                osDenominationActive: true,
            })
            expect(judged.txs).toEqual([])
            expect(judged.failedTxs).toEqual([])
        } finally {
            validate.mockRestore()
        }
    })
})
