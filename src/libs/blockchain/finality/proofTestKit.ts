/**
 * Builds finality proofs from first principles for the verifier's tests:
 * real ed25519 keys, a block m that orders the transactions and names who
 * may sign m + 1, and block m + 1 committing m's results and the storage root,
 * signed over the precommit message. Test code only.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { precommitMessage } from "src/libs/consensus/v2/commitLock/messages"
import { auditPath, root, toHex } from "src/libs/crypto/merkle/rfc6962"
import { SparseMerkleTree } from "src/libs/crypto/merkle/sparse"
import {
    storageProgramKey,
    storageProgramLeafHex,
    storageProgramRecord,
    type StorageProgramRow,
} from "./storageRecord"
import type {
    BlockBytes,
    SignedHeader,
    StorageProof,
    TransactionProof,
} from "./verify"

export interface Key {
    identity: string
    privateKey: KeyObject
}

export const sha256Hex = (data: string | Uint8Array): string =>
    createHash("sha256").update(data).digest("hex")

export function newKey(): Key {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    return { identity: `0x${raw.toString("hex")}`, privateKey }
}

/** `count` fresh keys in identity order. */
export const sortedKeys = (count: number): Key[] =>
    Array.from({ length: count }, newKey).sort((a, b) => (a.identity < b.identity ? -1 : 1))

export function blockOf(number: number, content: Record<string, unknown>): BlockBytes {
    const contentBytes = JSON.stringify(content)
    return { number, hash: sha256Hex(contentBytes), contentBytes }
}

/**
 * The block with `round`'s precommit message as its signed message, signed
 * by `signers` over `message` (by default that same precommit message).
 */
export function certify(
    block: BlockBytes,
    signers: Key[],
    round: number,
    message = precommitMessage(block.number, round, block.hash),
): SignedHeader {
    const signatures: Record<string, string> = {}
    for (const k of signers) {
        signatures[k.identity] = sign(null, Buffer.from(message, "utf8"), k.privateKey).toString("hex")
    }
    return { ...block, round, signedMessage: precommitMessage(block.number, round, block.hash), signatures }
}

export interface ProofChainSpec {
    /** Block m, the inclusion block. */
    number: number
    transactions: string[]
    /** One canonical result text per transaction, in order. */
    results: string[]
    /** Committed by block m + 1 as well as, unless overridden, by block m. */
    peerlist: string[]
    setHash: string
    signers: Key[]
    round: number
    /** Block m's peerlist and validator set: who may sign m + 1. */
    inclusionPeerlist?: string[]
    inclusionSetHash?: string
    previousHash?: string
    storageRoot?: string
}

/** Block m and block m + 1 with its certificate. */
export function buildChain(spec: ProofChainSpec): { inclusion: BlockBytes; commit: SignedHeader } {
    const m = spec.number
    const storage = { native_storage_programs: spec.storageRoot ?? "00".repeat(32) }
    const inclusion = blockOf(m, {
        previousHash: spec.previousHash ?? sha256Hex(`block ${m - 1}`),
        ordered_transactions: spec.transactions,
        peerlist: spec.inclusionPeerlist ?? spec.peerlist,
        native_tables_hashes: storage,
        number: m,
        parent_results_root: sha256Hex(`results of ${m - 1}`),
        validator_set_hash: spec.inclusionSetHash ?? spec.setHash,
    })
    const commit = blockOf(m + 1, {
        previousHash: inclusion.hash,
        ordered_transactions: [],
        peerlist: spec.peerlist,
        native_tables_hashes: storage,
        number: m + 1,
        parent_results_root: toHex(root(resultBytes(spec.results))),
        validator_set_hash: spec.setHash,
    })
    return { inclusion, commit: certify(commit, spec.signers, spec.round) }
}

const resultBytes = (results: string[]) => results.map(text => new TextEncoder().encode(text))

/** getTransactionProof's answer for the transaction at `index`. */
export function buildTxProof(spec: ProofChainSpec, index: number): TransactionProof {
    const { inclusion, commit } = buildChain(spec)
    return {
        hash: spec.transactions[index],
        blockNumber: spec.number,
        leafIndex: index,
        treeSize: spec.transactions.length,
        leaf: spec.results[index],
        auditPath: auditPath(resultBytes(spec.results), index).map(toHex),
        committedIn: spec.number + 1,
        inclusionBlock: inclusion,
        commitBlock: commit,
    }
}

/** getStorageProof's answer for `addresses` over a state holding `rows`. */
export function buildStorageProof(
    spec: ProofChainSpec,
    rows: StorageProgramRow[],
    addresses: string[],
): StorageProof {
    const tree = SparseMerkleTree.build(
        rows.map(r => ({ key: storageProgramKey(r.storageAddress), valueHash: storageProgramLeafHex(r) })),
    )
    const { inclusion, commit } = buildChain({ ...spec, storageRoot: tree.rootHex })
    return {
        anchor: commit,
        anchorParent: inclusion,
        asOfBlock: spec.number,
        proofs: addresses.map(address => {
            const row = rows.find(r => r.storageAddress === address)
            return {
                storageAddress: address,
                record: row ? storageProgramRecord(row) : null,
                ...tree.prove(storageProgramKey(address)),
            }
        }),
    }
}
