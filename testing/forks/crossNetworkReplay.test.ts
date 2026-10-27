/**
 * A signature made for one network does not verify on another.
 *
 * This covers the preimage, the gate wiring and the verifier: genesis goes
 * through the fork loader, which sets the chain id and the signatureDomain
 * schedule, and the check is pendingTxSignatureContext feeding
 * validateTxSignature. It does not drive RPC or mempool admission end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { pendingTxSignatureContext } from "@/forks/signatureDomainGate"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"
import { validateTxSignature } from "@/libs/blockchain/validation/txValidator"
import { createTestSigner, type TestSigner } from "../vectors/testSigner"

const HASH = "9f".repeat(32)

/** Boot a node from a genesis: the chain id and the signatureDomain schedule. */
function bootNode(
    chainId: number,
    signatureDomainAt: number | null,
    tip = 50,
): void {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    loadForkConfigFromGenesis({
        properties: { id: chainId, name: "TEST", currency: "DEM" },
        balances: [],
        forks:
            signatureDomainAt === null
                ? {}
                : { signatureDomain: { activationHeight: signatureDomainAt } },
    })
    getSharedState.lastBlockNumber = tip
}

async function admits(signer: TestSigner, signature: string): Promise<boolean> {
    const tx = {
        hash: HASH,
        content: {
            from: signer.publicKeyHex,
            from_ed25519_address: signer.publicKeyHex,
        },
        signature: { type: "ed25519", data: signature },
    } as unknown as Transaction
    const result = await validateTxSignature(tx, null, pendingTxSignatureContext())
    return result.valid
}

describe("cross-network replay", () => {
    let snapshot: ForkConfigByName
    let chainIdSnapshot: number | null
    let tipSnapshot: number
    let signer: TestSigner
    let legacySig: string
    let domainSigChain1: string
    let domainSigChain1337: string

    beforeEach(async () => {
        snapshot = cloneDefaultForkConfig()
        chainIdSnapshot = getSharedState.chainId
        tipSnapshot = getSharedState.lastBlockNumber
        signer = await createTestSigner()
        const sign = (bytes: Uint8Array) => signer.sign(bytes)
        legacySig = await sign(txSignaturePreimage(HASH, 0, false))
        domainSigChain1 = await sign(txSignaturePreimage(HASH, 1, true))
        domainSigChain1337 = await sign(txSignaturePreimage(HASH, 1337, true))
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
        getSharedState.chainId = chainIdSnapshot
        getSharedState.lastBlockNumber = tipSnapshot
    })

    describe("node with id 1337 and signatureDomain active from genesis", () => {
        beforeEach(() => bootNode(1337, 0))

        it("rejects a legacy bare-hash signature", async () => {
            expect(await admits(signer, legacySig)).toBe(false)
        })

        it("rejects a signature made for chain id 1", async () => {
            expect(await admits(signer, domainSigChain1)).toBe(false)
        })

        it("accepts a signature made for chain id 1337", async () => {
            expect(await admits(signer, domainSigChain1337)).toBe(true)
        })
    })

    describe("node with id 1", () => {
        it("accepts a chain-1 domain signature once signatureDomain is active", async () => {
            bootNode(1, 0)
            expect(await admits(signer, domainSigChain1)).toBe(true)
            expect(await admits(signer, legacySig)).toBe(false)
        })

        it("accepts a legacy signature while signatureDomain is unscheduled", async () => {
            bootNode(1, null)
            expect(await admits(signer, legacySig)).toBe(true)
        })

        it("rejects a chain-1337 domain signature either way", async () => {
            bootNode(1, 0)
            expect(await admits(signer, domainSigChain1337)).toBe(false)
            bootNode(1, null)
            expect(await admits(signer, domainSigChain1337)).toBe(false)
        })
    })

    it("a legacy node does not separate networks: the replay the fork closes", async () => {
        // Same signature, two different networks, both unscheduled: both
        // accept. This is why a mainnet genesis must schedule the fork.
        bootNode(1, null)
        const onOne = await admits(signer, legacySig)
        bootNode(1337, null)
        const on1337 = await admits(signer, legacySig)
        expect([onOne, on1337]).toEqual([true, true])
    })
})

describe("committed devnet genesis", () => {
    const devnet = JSON.parse(
        readFileSync(
            resolve(import.meta.dir, "../devnet/genesis.devnet.json"),
            "utf8",
        ),
    )
    let snapshot: ForkConfigByName
    let chainIdSnapshot: number | null
    let tipSnapshot: number

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        chainIdSnapshot = getSharedState.chainId
        tipSnapshot = getSharedState.lastBlockNumber
    })
    afterEach(() => {
        getSharedState.forkConfig = snapshot
        getSharedState.chainId = chainIdSnapshot
        getSharedState.lastBlockNumber = tipSnapshot
    })

    it("has its own chain id and binds signatures from height 0", () => {
        expect(devnet.properties.id).toBe(1337)
        expect(devnet.forks.signatureDomain).toEqual({ activationHeight: 0 })
    })

    it("boots a node that refuses a signature made for chain id 1", async () => {
        getSharedState.forkConfig = cloneDefaultForkConfig()
        loadForkConfigFromGenesis(devnet)
        getSharedState.lastBlockNumber = 0
        const signer = await createTestSigner()
        const sig = (chainId: number) =>
            signer.sign(txSignaturePreimage(HASH, chainId, true))

        expect(getSharedState.chainId).toBe(1337)
        expect(await admits(signer, await sig(1))).toBe(false)
        expect(await admits(signer, await sig(1337))).toBe(true)
    })
})
