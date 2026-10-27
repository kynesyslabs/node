import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import type { Block, Transaction } from "@kynesyslabs/demosdk/types"

import { validateTx } from "./txValidator"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"
import { serializeTxContent } from "@/libs/crypto/txContentSerializer"
import { BATCH_SIGNATURE_DOMAIN } from "@/libs/l2ps/constants"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import {
    createTestSigner,
    type TestSigner,
} from "../../../../testing/vectors/testSigner"

// The real pool runs workers; the verdicts under test come from the same pure
// validator the workers call, driven with whatever context the caller passes.
mock.module("./txValidatorPool", () => ({
    default: {
        getInstance: () => ({
            validate: (txs: Transaction[], isPostFork: boolean, domain: any) =>
                Promise.all(txs.map(tx => validateTx(tx, null, isPostFork, domain))),
        }),
    },
}))

const { verifyBlockTxSignatures } = await import("./verifyBlockTxSignatures")

const CHAIN_ID = 1337
const ACTIVATION = 100

describe("verifyBlockTxSignatures", () => {
    let snapshot: ForkConfigByName
    let chainIdSnapshot: number | null
    let tipSnapshot: number
    let signer: TestSigner

    beforeEach(async () => {
        snapshot = cloneDefaultForkConfig()
        chainIdSnapshot = getSharedState.chainId
        tipSnapshot = getSharedState.lastBlockNumber
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.forkConfig.signatureDomain.activationHeight = ACTIVATION
        getSharedState.chainId = CHAIN_ID
        // A node that has already moved far past the block being checked:
        // the verdict must follow the block's height, not the tip.
        getSharedState.lastBlockNumber = ACTIVATION + 500
        signer = await createTestSigner()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
        getSharedState.chainId = chainIdSnapshot
        getSharedState.lastBlockNumber = tipSnapshot
    })

    async function signedTx(
        nonce: number,
        how: { active: boolean; chainId: number },
    ): Promise<Transaction> {
        const content = {
            type: "native",
            from: signer.publicKeyHex,
            from_ed25519_address: signer.publicKeyHex,
            to: "0x" + "ef".repeat(32),
            amount: 1,
            nonce,
        }
        // osDenomination is active from genesis in the default config, so the
        // hash commits to the OS-string serialization.
        const hash = createHash("sha256")
            .update(serializeTxContent(content as any, true), "utf8")
            .digest("hex")
        const signature = await signer.sign(
            txSignaturePreimage(hash, how.chainId, how.active),
        )
        return {
            hash,
            content,
            signature: { type: "ed25519", data: signature },
        } as unknown as Transaction
    }

    const blockOf = (number: number, txs: Transaction[]) =>
        ({
            number,
            content: { ordered_transactions: txs.map(t => t.hash) },
        }) as unknown as Pick<Block, "number" | "content">

    it("accepts legacy signatures in a block below the activation height", async () => {
        const tx = await signedTx(1, { active: false, chainId: 0 })

        expect(
            (await verifyBlockTxSignatures(blockOf(ACTIVATION - 1, [tx]), [tx])).valid,
        ).toBe(true)
    })

    it("rejects a legacy signature in a block at the activation height", async () => {
        const tx = await signedTx(2, { active: false, chainId: 0 })

        const verdict = await verifyBlockTxSignatures(blockOf(ACTIVATION, [tx]), [tx])

        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain(tx.hash)
    })

    it("accepts a signature bound to this chain from the activation height on", async () => {
        const tx = await signedTx(3, { active: true, chainId: CHAIN_ID })

        expect(
            (await verifyBlockTxSignatures(blockOf(ACTIVATION + 7, [tx]), [tx])).valid,
        ).toBe(true)
    })

    it("rejects a signature bound to another chain id", async () => {
        const tx = await signedTx(4, { active: true, chainId: 1 })

        expect(
            (await verifyBlockTxSignatures(blockOf(ACTIVATION + 7, [tx]), [tx])).valid,
        ).toBe(false)
    })

    it("rejects a domain signature in a block below activation", async () => {
        const tx = await signedTx(5, { active: true, chainId: CHAIN_ID })

        expect(
            (await verifyBlockTxSignatures(blockOf(ACTIVATION - 1, [tx]), [tx])).valid,
        ).toBe(false)
    })

    it("rejects a transaction whose hash does not describe its content", async () => {
        const tx = await signedTx(6, { active: true, chainId: CHAIN_ID })
        ;(tx.content as any).amount = 1_000_000

        expect(
            (await verifyBlockTxSignatures(blockOf(ACTIVATION, [tx]), [tx])).valid,
        ).toBe(false)
    })

    it("rejects a transaction the block does not list", async () => {
        const listed = await signedTx(7, { active: true, chainId: CHAIN_ID })
        const stray = await signedTx(8, { active: true, chainId: CHAIN_ID })

        const verdict = await verifyBlockTxSignatures(
            blockOf(ACTIVATION, [listed]),
            [listed, stray],
        )

        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("not part of block")
    })

    it("fails closed when the fork is active but genesis declared no chain id", async () => {
        getSharedState.chainId = null
        const tx = await signedTx(9, { active: true, chainId: CHAIN_ID })

        const verdict = await verifyBlockTxSignatures(blockOf(ACTIVATION, [tx]), [tx])

        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("signature context")
    })

    it("has nothing to check for genesis or an empty block", async () => {
        expect((await verifyBlockTxSignatures(blockOf(0, []), [])).valid).toBe(true)
        expect((await verifyBlockTxSignatures(blockOf(ACTIVATION, []), [])).valid).toBe(true)
    })

    describe("the supplied transactions must be the block's own list", () => {
        it("rejects an empty list for a block that lists transactions", async () => {
            const tx = await signedTx(20, { active: true, chainId: CHAIN_ID })

            const verdict = await verifyBlockTxSignatures(
                blockOf(ACTIVATION, [tx]),
                [],
            )

            expect(verdict.valid).toBe(false)
            expect(verdict.reason).toContain("were not supplied")
        })

        it("rejects a list that leaves a listed transaction out", async () => {
            const a = await signedTx(21, { active: true, chainId: CHAIN_ID })
            const b = await signedTx(22, { active: true, chainId: CHAIN_ID })

            const verdict = await verifyBlockTxSignatures(
                blockOf(ACTIVATION, [a, b]),
                [a],
            )

            expect(verdict.valid).toBe(false)
        })

        it("rejects the same transaction supplied twice", async () => {
            const a = await signedTx(23, { active: true, chainId: CHAIN_ID })
            const b = await signedTx(24, { active: true, chainId: CHAIN_ID })

            const verdict = await verifyBlockTxSignatures(
                blockOf(ACTIVATION, [a, b]),
                [a, a],
            )

            expect(verdict.valid).toBe(false)
            expect(verdict.reason).toContain("twice")
        })

        it("rejects a block that lists one hash twice", async () => {
            const a = await signedTx(25, { active: true, chainId: CHAIN_ID })
            const block = {
                number: ACTIVATION,
                content: { ordered_transactions: [a.hash, a.hash] },
            } as unknown as Pick<Block, "number" | "content">

            const verdict = await verifyBlockTxSignatures(block, [a])

            expect(verdict.valid).toBe(false)
            expect(verdict.reason).toContain("more than once")
        })

        it("accepts the same set in a different order", async () => {
            const a = await signedTx(26, { active: true, chainId: CHAIN_ID })
            const b = await signedTx(27, { active: true, chainId: CHAIN_ID })

            expect(
                (await verifyBlockTxSignatures(blockOf(ACTIVATION, [a, b]), [b, a])).valid,
            ).toBe(true)
        })
    })

    it("passes legacy signatures through when the fork is unscheduled and genesis has no chain id", async () => {
        // Nothing binds to a chain id while the fork is off, so a missing id is
        // not an error: it must not be read, let alone made fatal.
        getSharedState.forkConfig.signatureDomain.activationHeight = null
        getSharedState.chainId = null
        const tx = await signedTx(28, { active: false, chainId: 0 })

        expect(
            (await verifyBlockTxSignatures(blockOf(ACTIVATION + 50, [tx]), [tx])).valid,
        ).toBe(true)
    })

    describe("system relay transactions", () => {
        // The shape the L2PS batch aggregator builds and signs.
        async function batchTx(
            tamper?: (content: any) => void,
            signOver: "domain" | "hash" = "domain",
        ): Promise<Transaction> {
            const content: any = {
                type: "l2psBatch",
                from: signer.publicKeyHex,
                to: signer.publicKeyHex,
                from_ed25519_address: signer.publicKeyHex,
                amount: 0,
                timestamp: 1_760_000_000_123,
                nonce: 1_760_000_000_123,
                fee: 0,
                data: [
                    "l2psBatch",
                    {
                        block_number: 7,
                        batch_hash: "ab".repeat(32),
                        transaction_count: 3,
                    },
                ],
                transaction_fee: {
                    network_fee: 0,
                    rpc_fee: 0,
                    additional_fee: 0,
                    rpc_address: null,
                },
            }
            const contentString = JSON.stringify(content)
            const hash = createHash("sha256").update(contentString).digest("hex")
            const signed =
                signOver === "domain"
                    ? new TextEncoder().encode(`${BATCH_SIGNATURE_DOMAIN}:${contentString}`)
                    : new TextEncoder().encode(hash)
            const signature = await signer.sign(signed)
            if (tamper) tamper(content)
            return {
                hash,
                content,
                signature: {
                    type: "ed25519",
                    data: signature,
                    domain: BATCH_SIGNATURE_DOMAIN,
                },
            } as unknown as Transaction
        }

        it("accepts a genuine batch next to standard transactions in a domain-bound block", async () => {
            const batch = await batchTx()
            const std = await signedTx(30, { active: true, chainId: CHAIN_ID })

            const verdict = await verifyBlockTxSignatures(
                blockOf(ACTIVATION + 1, [batch, std]),
                [std, batch],
            )

            expect(verdict.valid).toBe(true)
        })

        it("rejects a batch whose content changed after signing", async () => {
            const batch = await batchTx(c => {
                c.data[1].transaction_count = 3000
            })

            expect(
                (await verifyBlockTxSignatures(blockOf(ACTIVATION, [batch]), [batch])).valid,
            ).toBe(false)
        })

        it("rejects a batch signed over the bare hash instead of the batch domain", async () => {
            const batch = await batchTx(undefined, "hash")

            expect(
                (await verifyBlockTxSignatures(blockOf(ACTIVATION, [batch]), [batch])).valid,
            ).toBe(false)
        })

        it("rejects a validly signed batch labelled with another signature domain", async () => {
            const batch = await batchTx()
            ;(batch.signature as any).domain = "L2PS_OTHER_V1"

            const verdict = await verifyBlockTxSignatures(
                blockOf(ACTIVATION, [batch]),
                [batch],
            )

            expect(verdict.valid).toBe(false)
            expect(verdict.reason).toContain("wrong signature domain")
        })

        it("rejects a validly signed batch with no signature domain label", async () => {
            const batch = await batchTx()
            delete (batch.signature as any).domain

            expect(
                (await verifyBlockTxSignatures(blockOf(ACTIVATION, [batch]), [batch])).valid,
            ).toBe(false)
        })

        it("rejects a batch whose signature belongs to another key", async () => {
            const batch = await batchTx()
            ;(batch.content as any).from = "0x" + "cd".repeat(32)

            expect(
                (await verifyBlockTxSignatures(blockOf(ACTIVATION, [batch]), [batch])).valid,
            ).toBe(false)
        })

        it("rejects the unsigned local record of the L2PS consensus step", async () => {
            const local = {
                type: "l2psBatch",
                hash: "0x" + "ee".repeat(32),
                signature: { type: "ed25519", data: "" },
                content: {
                    type: "l2psBatch",
                    from: "l2ps:consensus",
                    to: "l2ps:batch",
                    amount: 0,
                    nonce: 9,
                    timestamp: 1,
                    data: ["l2psBatch", { block_number: 9 }],
                },
            } as unknown as Transaction

            const verdict = await verifyBlockTxSignatures(
                blockOf(ACTIVATION, [local]),
                [local],
            )

            expect(verdict.valid).toBe(false)
            expect(verdict.reason).toContain("unsigned")
        })

        it("does not exempt a standard transaction that merely calls itself a batch", async () => {
            // Signed the standard way, labelled l2psBatch: the relay rule applies
            // to the label, and the standard signature does not satisfy it.
            const tx = await signedTx(31, { active: true, chainId: CHAIN_ID })
            ;(tx.content as any).type = "l2psBatch"

            expect(
                (await verifyBlockTxSignatures(blockOf(ACTIVATION, [tx]), [tx])).valid,
            ).toBe(false)
        })
    })
})
