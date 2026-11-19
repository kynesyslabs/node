/**
 * Test-only builders for settlement transfers and batches. Commitments and
 * signature messages come from encoding.ts and keys from fixed seeds, so a
 * test never hand-writes a commitment.
 */
import crypto from "node:crypto"
import vectors from "./settlementVectors.json"
import {
    SETTLEMENT_VERSION,
    compareAccounts,
    fieldToHex,
    settlementCommitment,
    settlementSignatureMessage,
} from "../encoding"
import type { DecryptedTransfer, SettlementChange } from "../types"
import type { SettlementRecord } from "../validation"

export const CHAIN_ID: number = vectors.chainId
export const UID: string = vectors.l2psUid
export { vectors }

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

export interface TestKey {
    seed: string
    account: string
    sign(message: Uint8Array): string
}

export function keyFromSeed(seed: string): TestKey {
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed.slice(2), "hex")]),
        format: "der",
        type: "pkcs8",
    })
    const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" })
    const account = "0x" + Buffer.from(spki).subarray(-32).toString("hex")
    return {
        seed,
        account,
        sign: message => "0x" + crypto.sign(null, Buffer.from(message), privateKey).toString("hex"),
    }
}

/** Key n: seed of 32 bytes all equal to n. */
export const key = (n: number): TestKey => keyFromSeed("0x" + n.toString(16).padStart(2, "0").repeat(32))

export interface TransferSpec {
    from: TestKey
    to: string
    amount: bigint
    fee: bigint
    nonce: bigint
    salt?: bigint
    txHash?: string
    chainId?: number
    l2psUid?: string
}

export function signedTransfer(spec: TransferSpec): DecryptedTransfer {
    const salt = spec.salt ?? BigInt(spec.nonce) * 7919n + 17n
    const opening = {
        from: spec.from.account,
        to: spec.to,
        amount: spec.amount,
        fee: spec.fee,
        nonce: spec.nonce,
        salt,
    }
    const commitment = settlementCommitment(opening)
    const signature = spec.from.sign(
        settlementSignatureMessage(spec.chainId ?? CHAIN_ID, spec.l2psUid ?? UID, commitment),
    )
    return {
        txHash: spec.txHash ?? `l2ps_${spec.from.account.slice(2, 10)}_${spec.nonce}`,
        ...opening,
        commitment,
        signature,
    }
}

/** The decrypted inner transaction the SDK sends for a transfer. */
export function innerTx(t: DecryptedTransfer, l2psUid = UID) {
    return {
        hash: t.txHash,
        content: {
            type: "native",
            from: t.from,
            to: t.to,
            nonce: Number(t.nonce),
            amount: 0,
            data: [
                "native",
                {
                    nativeOperation: "send",
                    args: [t.to, t.amount.toString()],
                    l2ps_uid: l2psUid,
                    settlement: {
                        fee: t.fee.toString(),
                        salt: fieldToHex(t.salt),
                        commitment: fieldToHex(t.commitment),
                        signature: t.signature,
                    },
                },
            ],
        },
    }
}

/** Net balance changes of transfers applied in order: sorted, unique, fees in the senders' deltas. */
export function netChanges(transfers: DecryptedTransfer[]): SettlementChange[] {
    const delta = new Map<string, bigint>()
    for (const t of transfers) {
        delta.set(t.from, (delta.get(t.from) ?? 0n) - t.amount - t.fee)
        delta.set(t.to, (delta.get(t.to) ?? 0n) + t.amount)
    }
    return [...delta]
        .map(([account, d]) => ({ account, delta: d }))
        .sort((a, b) => compareAccounts(a.account, b.account))
}

export function recordOf(
    transfers: DecryptedTransfer[],
    changes: SettlementChange[] = netChanges(transfers),
): SettlementRecord {
    return {
        version: SETTLEMENT_VERSION,
        transfers: transfers.map(t => ({
            commitment: fieldToHex(t.commitment),
            signer: t.from,
            nonce: t.nonce.toString(),
            fee: t.fee.toString(),
            signature: t.signature,
        })),
        changes: changes.map(c => ({ account: c.account, delta: c.delta.toString() })),
        proof: { protocol: "plonk", test: true },
    }
}

let batchSeq = 0

/** An l2psBatch transaction carrying `record`, as a block holds it. */
export function batchTx(
    record: unknown,
    opts: { from?: string; nonce?: number; hash?: string; l2psUid?: string } = {},
) {
    batchSeq++
    const from = opts.from ?? key(200).account
    return {
        hash: opts.hash ?? crypto.createHash("sha256").update(`batch-${batchSeq}-${JSON.stringify(record)}`).digest("hex"),
        blockNumber: 101,
        signature: { type: "ed25519", data: "00" },
        status: "pending",
        content: {
            type: "l2psBatch",
            from,
            to: from,
            from_ed25519_address: from,
            amount: 0,
            nonce: opts.nonce ?? 1_800_000_000_000_000 + batchSeq,
            timestamp: 1_800_000_000_000 + batchSeq,
            data: [
                "l2psBatch",
                {
                    l2ps_uid: opts.l2psUid ?? UID,
                    encrypted_batch: "",
                    transaction_count: 0,
                    batch_hash: "00",
                    transaction_hashes: [],
                    authentication_tag: "00",
                    settlement: record,
                },
            ],
            transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
        },
    } as any
}
