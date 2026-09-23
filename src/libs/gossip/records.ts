import {
    hexToUint8Array,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"

import TxValidatorPool from "src/libs/blockchain/validation/txValidatorPool"
import { getSharedState } from "src/utilities/sharedState"

export interface HeightsRecord {
    v: 1
    pubkey: string
    peerId: string
    addrs: string[]
    height: number
    headHash: string
    seq: number
    sig: string
}

/**
 * Canonical signing form: keys sorted lexicographically, sig excluded.
 */
export function heightsSigningBytes(
    record: Omit<HeightsRecord, "sig">,
): Uint8Array {
    const sorted = Object.fromEntries(
        Object.entries(record)
            .filter(([k]) => k !== "sig")
            .sort(([a], [b]) => (a < b ? -1 : 1)),
    )
    return new TextEncoder().encode(JSON.stringify(sorted))
}

export async function buildHeightsRecord(
    peerId: string,
    addrs: string[],
): Promise<HeightsRecord> {
    const unsigned: Omit<HeightsRecord, "sig"> = {
        v: 1,
        pubkey: getSharedState.publicKeyHex,
        peerId,
        addrs: addrs.slice(0, 4),
        height: getSharedState.lastBlockNumber,
        headHash: getSharedState.lastBlockHash,
        seq: Date.now(),
    }
    const signed = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        heightsSigningBytes(unsigned),
    )
    return { ...unsigned, sig: uint8ArrayToHex(signed.signature) }
}

export async function verifyHeightsRecord(
    record: HeightsRecord,
): Promise<boolean> {
    try {
        return await TxValidatorPool.getInstance().verify({
            algorithm: getSharedState.signingAlgorithm,
            message: heightsSigningBytes(record),
            signature: hexToUint8Array(record.sig),
            publicKey: hexToUint8Array(record.pubkey),
        })
    } catch {
        return false
    }
}

export function isHeightsRecordShape(x: unknown): x is HeightsRecord {
    const r = x as HeightsRecord
    return (
        r != null &&
        r.v === 1 &&
        typeof r.pubkey === "string" &&
        typeof r.peerId === "string" &&
        Array.isArray(r.addrs) &&
        r.addrs.length <= 4 &&
        r.addrs.every(a => typeof a === "string" && a.length < 256) &&
        typeof r.height === "number" &&
        Number.isInteger(r.height) &&
        r.height >= 0 &&
        typeof r.headHash === "string" &&
        typeof r.seq === "number" &&
        typeof r.sig === "string"
    )
}
