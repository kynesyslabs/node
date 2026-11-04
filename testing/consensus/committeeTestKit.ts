/**
 * Shared setup for the committee suites that run the real committee draw
 * and verifier against a stubbed chain. Bun module mocks must be installed
 * before the modules under test are imported, so each suite calls
 * `mockCommitteeChain` first and imports its subjects dynamically after.
 */

import { jest } from "bun:test"
import { getUnifiedCryptoInstance, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import Hashing from "src/libs/crypto/hashing"

/** Mutable chain view the mocks read on every call. */
export interface StubChain {
    /** Peerlist every stored block commits. */
    peerlist: string[]
    /** Staked validators per the GCR; null means exactly `peerlist`. */
    staked: string[] | null
    /** Highest stored block. */
    tip: number
}

class FakePeerManager {
    static getInstance() {
        return new FakePeerManager()
    }
    async getOnlinePeers() {
        return []
    }
    getPeers() {
        return []
    }
    getPeer() {
        return undefined
    }
}

/** Mock the logger, shared state, peer manager, chain storage and GCR. */
export function mockCommitteeChain(sharedState: Record<string, unknown>, chain: StubChain): void {
    jest.mock("src/utilities/logger", () => ({
        __esModule: true,
        default: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
            only: jest.fn(),
            custom: jest.fn(),
        },
    }))
    jest.mock("src/utilities/sharedState", () => ({
        __esModule: true,
        default: sharedState,
        getSharedState: sharedState,
    }))
    jest.mock("src/libs/peer/PeerManager", () => ({
        __esModule: true,
        default: FakePeerManager,
    }))
    jest.mock("src/libs/peer", () => ({
        Peer: class {},
        PeerManager: FakePeerManager,
    }))
    jest.mock("src/libs/blockchain/chain", () => ({
        __esModule: true,
        default: {
            getBlockByNumber: async (n: number) =>
                n >= 0 && n <= chain.tip
                    ? {
                          number: n,
                          hash: `hash-${n}`,
                          content: { peerlist: chain.peerlist, timestamp: 1000 + n },
                      }
                    : null,
            getGenesisBlockHash: async () => "hash-0",
        },
    }))
    jest.mock("src/libs/blockchain/gcr/gcr", () => ({
        __esModule: true,
        default: {
            getGCRValidatorsAtBlock: async () =>
                (chain.staked ?? chain.peerlist).map(address => ({ address })),
        },
    }))
}

export interface Signer {
    identity: string
    sign: (message: string) => Promise<string>
}

/** An ed25519 signer from the SDK's unified crypto, the node's own primitive. */
export async function makeSigner(label: string, seedByte: number): Promise<Signer> {
    const seed = new Uint8Array(128).fill(seedByte)
    const crypto = getUnifiedCryptoInstance(label, seed)
    await crypto.generateIdentity("ed25519", seed)
    const { publicKey } = await crypto.getIdentity("ed25519")
    return {
        identity: uint8ArrayToHex(publicKey as Uint8Array),
        sign: async message => {
            const signed = await crypto.sign("ed25519", new TextEncoder().encode(message))
            return uint8ArrayToHex(signed.signature as Uint8Array)
        },
    }
}

/** An unsigned block at height 10 on top of `hash-9`, with a real content hash. */
export function makeBlock(nonce: string) {
    const content = { previousHash: "hash-9", timestamp: 1500, nonce }
    return {
        number: 10,
        hash: Hashing.sha256(JSON.stringify(content)),
        content,
        validation_data: { signatures: {} as Record<string, string> },
    } as any
}

/** Add each signer's signature over the block's hash. */
export async function signedBy(block: any, signers: Signer[]) {
    for (const signer of signers) {
        block.validation_data.signatures[signer.identity] = await signer.sign(block.hash)
    }
    return block
}
