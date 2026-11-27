/**
 * A message's L2PS inner transaction must open wherever an envelope is
 * opened: the node's own `decryptInnerTx` (admission, the settlement loop) and
 * the SDK's `L2PS.decryptTx`. Both check that `content.from` signed the
 * transaction hash preimage of the block it would land in, so the node signs
 * as itself over that preimage, never over the serialized content.
 *
 * The transaction is built by the real service path and sealed by the real
 * `ParallelNetworks.encryptTransaction` with a real SDK subnet; only the
 * mempool, the history store, the database and the signing worker pool are
 * stand-ins. The pool signs with the node identity, as its workers do.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import type { L2PSTransaction } from "@kynesyslabs/demosdk/types"

const submitted: L2PSTransaction[] = []

mock.module("@/model/datasource", () => ({ dataSource: {} }))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {
        addTransaction: async (_uid: string, envelope: L2PSTransaction) => {
            submitted.push(JSON.parse(JSON.stringify(envelope)))
            return { success: true }
        },
        updateStatus: async () => true,
    },
}))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    default: {
        execute: async () => ({ success: true }),
        recordTransaction: async () => 1,
    },
}))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            sign: (algorithm: string, data: Uint8Array) => ucrypto.sign(algorithm as never, data),
        }),
    },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { serializeTransactionContent } from "@/forks"
import { getSharedState } from "@/utilities/sharedState"
import { sealed, subnet } from "@/libs/l2ps/__fixtures__/chainSignedTransfer"
import type { L2PS } from "@kynesyslabs/demosdk/l2ps"

const { decryptInnerTx, INNER_TX_NOT_DOMAIN_SIGNED } = await import("@/libs/l2ps/innerTxDecrypt")
const parallelNetworks = (await import("@/libs/l2ps/parallelNetworks")).default
const { L2PSMessagingService } = await import("../L2PSMessagingService")

const CHAIN = 4242
const UID = "im_signature_subnet"
const SENDER = "ab".repeat(32)
const RECIPIENT = "cd".repeat(32)

await ucrypto.generateIdentity("ed25519", new Uint8Array(32).fill(9))
const nodeKey = (await ucrypto.getIdentity("ed25519")).publicKey as Uint8Array
const NODE = uint8ArrayToHex(nodeKey)

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    chainId: getSharedState.chainId,
    keypair: getSharedState.keypair,
    signingAlgorithm: getSharedState.signingAlgorithm,
}
const networks = parallelNetworks.getInstance() as any
const original = { getL2PS: networks.getL2PS, loadL2PS: networks.loadL2PS }
let l2ps: L2PS

/** signatureDomain from `height` (null: never), chain tip at 100. */
function chain(height: number | null): void {
    const forks = cloneDefaultForkConfig()
    forks.osDenomination.activationHeight = 0
    forks.signatureDomain.activationHeight = height
    getSharedState.forkConfig = forks
    getSharedState.chainId = CHAIN
    getSharedState.lastBlockNumber = 100
}

/** The envelope the service puts in the L2PS mempool for one message. */
async function sendMessage(): Promise<L2PSTransaction> {
    const service = L2PSMessagingService.getInstance() as any
    const at = Date.now()
    const result = await service.submitToL2PS(
        UID, SENDER, RECIPIENT, `msg-${at}-${submitted.length}`, `hash-${at}`,
        { ciphertext: "00", nonce: "00" }, at,
    )
    expect(result).toEqual({ success: true, txHash: expect.any(String) })
    return submitted[submitted.length - 1]
}

beforeEach(async () => {
    l2ps = await subnet(UID)
    networks.getL2PS = async () => l2ps
    networks.loadL2PS = async () => l2ps
    ;(getSharedState as any).signingAlgorithm = "ed25519"
    ;(getSharedState as any).keypair = { publicKey: nodeKey, privateKey: new Uint8Array(64) }
    submitted.length = 0
})

afterEach(() => {
    Object.assign(networks, original)
    Object.assign(getSharedState, saved)
})

describe("a message's inner transaction after signatureDomain activation", () => {
    beforeEach(() => chain(0))

    it("is signed by the node, which is the sender of record, and names the message sender", async () => {
        const inner = await decryptInnerTx(l2ps, await sendMessage(), "admit")
        expect(inner.content.from).toBe(NODE)
        expect(inner.content.from_ed25519_address).toBe(NODE)
        expect(inner.content.to).toBe(RECIPIENT)
        expect((inner.content.data as any)[1].senderId).toBe(SENDER)
    })

    it("opens for admission, as the settlement loop opens it", async () => {
        const envelope = await sendMessage()
        const inner = await decryptInnerTx(l2ps, envelope, "admit")
        expect(inner.hash).toBe((envelope.content.data[1] as any).original_hash)
    })

    it("opens with the SDK decrypt given the chain id", async () => {
        const envelope = await sendMessage()
        const inner = await l2ps.decryptTx(envelope, { chainId: CHAIN })
        expect(inner.hash).toBe((envelope.content.data[1] as any).original_hash)
    })

    it("is refused when signed over the serialized content instead of the hash preimage", async () => {
        const inner = await decryptInnerTx(l2ps, await sendMessage(), "admit")
        const contentSigned = await ucrypto.sign(
            "ed25519",
            new TextEncoder().encode(serializeTransactionContent(inner.content as never, 100)),
        )
        inner.signature = { type: "ed25519", data: uint8ArrayToHex(contentSigned.signature) } as never
        const envelope = await sealed(l2ps, inner)
        await expect(decryptInnerTx(l2ps, envelope, "admit")).rejects.toThrow("signature does not verify")
        await expect(l2ps.decryptTx(envelope, { chainId: CHAIN })).rejects.toThrow("signature does not verify")
    })
})

describe("a message's inner transaction before signatureDomain activation", () => {
    beforeEach(() => chain(null))

    it("is signed over the bare hash and opens on both paths", async () => {
        const envelope = await sendMessage()
        const hash = (envelope.content.data[1] as any).original_hash
        expect((await decryptInnerTx(l2ps, envelope, "admit")).hash).toBe(hash)
        expect((await l2ps.decryptTx(envelope)).hash).toBe(hash)
    })

    it("still opens as a stored row once the fork is active, and is refused for admission", async () => {
        const envelope = await sendMessage()
        chain(0)
        const hash = (envelope.content.data[1] as any).original_hash
        expect((await decryptInnerTx(l2ps, envelope, "stored")).hash).toBe(hash)
        await expect(decryptInnerTx(l2ps, envelope, "admit")).rejects.toThrow(INNER_TX_NOT_DOMAIN_SIGNED)
    })
})
