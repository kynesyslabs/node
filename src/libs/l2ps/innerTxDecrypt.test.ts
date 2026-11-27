/**
 * An L2PS inner transaction's signature is judged by the rule L1 applies to
 * the block it would land in. After signatureDomain activates an SDK client
 * signs `demos-tx:v1:<chainId>:<hash>`, which the node must accept on every
 * path that opens an envelope; admission refuses the legacy bare-hash form as
 * L1 does, and a signature for another chain is refused everywhere. Before
 * activation nothing changes. Envelopes are built and signed by the real SDK.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

mockLogger()

import type { L2PS } from "@kynesyslabs/demosdk/l2ps"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { plainSend, sealed, settledTransfer, signer, subnet } from "./__fixtures__/chainSignedTransfer"

const { decryptInnerTx, INNER_TX_NOT_DOMAIN_SIGNED } = await import("./innerTxDecrypt")
const { subnetDecryptor } = await import("./historyPayload")
const parallelNetworks = (await import("./parallelNetworks")).default

const CHAIN = 4242
const OTHER_CHAIN = 4243
const UID = "chain_id_subnet"

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    chainId: getSharedState.chainId,
}

/** signatureDomain from `height` (null: never), chain tip at 100. */
function chain(height: number | null, chainId: number | null = CHAIN): void {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.signatureDomain.activationHeight = height
    getSharedState.chainId = chainId
    getSharedState.lastBlockNumber = 100
}

let l2ps: L2PS
const domainSigner = () => signer({ domain: true, chainId: CHAIN })
const legacySigner = () => signer({ domain: false, chainId: CHAIN })
const foreignSigner = () => signer({ domain: true, chainId: OTHER_CHAIN })

beforeEach(async () => {
    l2ps = await subnet(UID)
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("after signatureDomain activation", () => {
    beforeEach(() => chain(0))

    it("a bare SDK decrypt refuses what an SDK client signs, which is the failure this fixes", async () => {
        const envelope = await sealed(l2ps, await settledTransfer(await domainSigner(), UID))
        await expect(l2ps.decryptTx(envelope)).rejects.toThrow("signature does not verify")
    })

    it.each(["admit", "stored"] as const)("%s opens a domain-signed settlement transfer", async use => {
        const inner = await settledTransfer(await domainSigner(), UID)
        const opened = await decryptInnerTx(l2ps, await sealed(l2ps, inner), use)
        expect(opened.hash).toBe(inner.hash)
        expect(opened.signature).toEqual(inner.signature)
    })

    it.each(["admit", "stored"] as const)("%s opens a domain-signed plain send", async use => {
        const inner = await plainSend(await domainSigner())
        expect((await decryptInnerTx(l2ps, await sealed(l2ps, inner), use)).hash).toBe(inner.hash)
    })

    it("admit refuses a legacy bare-hash signature, as L1 admission does", async () => {
        const envelope = await sealed(l2ps, await settledTransfer(await legacySigner(), UID))
        await expect(decryptInnerTx(l2ps, envelope, "admit")).rejects.toThrow(INNER_TX_NOT_DOMAIN_SIGNED)
        await expect(decryptInnerTx(l2ps, envelope)).rejects.toThrow(INNER_TX_NOT_DOMAIN_SIGNED)
    })

    it("stored still opens a row admitted with a legacy signature before activation", async () => {
        const inner = await settledTransfer(await legacySigner(), UID)
        expect((await decryptInnerTx(l2ps, await sealed(l2ps, inner), "stored")).hash).toBe(inner.hash)
    })

    it.each(["admit", "stored"] as const)("%s refuses a transaction signed for another chain", async use => {
        const envelope = await sealed(l2ps, await settledTransfer(await foreignSigner(), UID, { settlementChainId: CHAIN }))
        await expect(decryptInnerTx(l2ps, envelope, use)).rejects.toThrow("signature does not verify")
    })

    it("judges the block a transaction would land in: activation at the tip plus one already applies", async () => {
        chain(101)
        const envelope = await sealed(l2ps, await settledTransfer(await legacySigner(), UID))
        await expect(decryptInnerTx(l2ps, envelope, "admit")).rejects.toThrow(INNER_TX_NOT_DOMAIN_SIGNED)
        const inner = await settledTransfer(await domainSigner(), UID)
        expect((await decryptInnerTx(l2ps, await sealed(l2ps, inner), "admit")).hash).toBe(inner.hash)
    })

    it("fails closed when genesis declares no chain id", async () => {
        chain(0, null)
        const envelope = await sealed(l2ps, await settledTransfer(await domainSigner(), UID))
        await expect(decryptInnerTx(l2ps, envelope, "stored")).rejects.toThrow("properties.id")
    })
})

describe("before signatureDomain activation", () => {
    beforeEach(() => chain(null))

    it.each(["admit", "stored"] as const)(
        "%s opens a legacy-signed transfer and gives the SDK no chain id, as before",
        async use => {
            const inner = await settledTransfer(await legacySigner(), UID)
            const envelope = await sealed(l2ps, inner)
            const spy = jest.spyOn(l2ps, "decryptTx")
            try {
                expect((await decryptInnerTx(l2ps, envelope, use)).hash).toBe(inner.hash)
                expect(spy.mock.calls).toEqual([[envelope]])
            } finally {
                spy.mockRestore()
            }
        },
    )

    it.each(["admit", "stored"] as const)("%s refuses a domain-signed transfer, as L1 does before activation", async use => {
        const envelope = await sealed(l2ps, await settledTransfer(await domainSigner(), UID))
        await expect(decryptInnerTx(l2ps, envelope, use)).rejects.toThrow("signature does not verify")
    })

    it("activation scheduled two blocks ahead does not apply yet", async () => {
        chain(102)
        const inner = await settledTransfer(await legacySigner(), UID)
        expect((await decryptInnerTx(l2ps, await sealed(l2ps, inner), "admit")).hash).toBe(inner.hash)
    })
})

describe("the paths that open an envelope through ParallelNetworks", () => {
    const networks = parallelNetworks.getInstance() as any
    const original = { getL2PS: networks.getL2PS, loadL2PS: networks.loadL2PS }
    beforeEach(() => {
        chain(0)
        networks.getL2PS = async () => l2ps
        networks.loadL2PS = async () => l2ps
    })
    afterEach(() => Object.assign(networks, original))

    it("decryptTransaction opens a domain-signed transfer and refuses a legacy one", async () => {
        const inner = await settledTransfer(await domainSigner(), UID)
        expect((await networks.decryptTransaction(UID, await sealed(l2ps, inner))).hash).toBe(inner.hash)
        const legacy = await sealed(l2ps, await settledTransfer(await legacySigner(), UID))
        await expect(networks.decryptTransaction(UID, legacy)).rejects.toThrow(INNER_TX_NOT_DOMAIN_SIGNED)
    })

    it("history opens domain-signed and legacy rows, and refuses another chain's", async () => {
        const decrypt = await subnetDecryptor(UID)
        const inner = await settledTransfer(await domainSigner(), UID)
        expect((await decrypt(await sealed(l2ps, inner)))?.hash).toBe(inner.hash)
        const legacy = await settledTransfer(await legacySigner(), UID)
        expect((await decrypt(await sealed(l2ps, legacy)))?.hash).toBe(legacy.hash)
        const foreign = await sealed(l2ps, await settledTransfer(await foreignSigner(), UID, { settlementChainId: CHAIN }))
        await expect(decrypt(foreign)).rejects.toThrow("signature does not verify")
    })
})
