import {
    createHash,
    generateKeyPairSync,
    sign as edSign,
    type KeyObject,
} from "node:crypto"
import { serializeTransactionContent } from "@/forks"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"

/**
 * Real ed25519 accounts and transactions whose hash and signature verify, for
 * tests that check what a peer serves against what a block committed to.
 */

export interface TestAccount {
    address: string
    privateKey: KeyObject
}

export function newAccount(): TestAccount {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    return { address: "0x" + raw.toString("hex"), privateKey }
}

export interface TestTxOptions {
    nonce?: number
    status?: string
    attrs?: Record<string, unknown>
    /** Signs with this key instead of the sender's. */
    signer?: TestAccount
    /** Height recorded on the tx; also the one whose serializer hashes it. */
    height: number
    /** Hash with the rules of this height instead, e.g. the one before a fork. */
    hashHeight?: number
    /** Amounts and fees as plain DEM numbers, the pre-denomination wire shape. */
    legacyAmounts?: boolean
    /** Sign the chain-bound preimage for this chain id instead of the bare hash. */
    signatureChainId?: number
}

export function makeSignedTx(
    sender: TestAccount,
    recipient: TestAccount,
    options: TestTxOptions,
): any {
    const nonce = options.nonce ?? 1
    const content: any = {
        type: "native",
        from: sender.address,
        to: recipient.address,
        from_ed25519_address: sender.address,
        amount: options.legacyAmounts ? 1000 : "1000",
        data: [
            "native",
            { nativeOperation: "send", args: [recipient.address, "1000"] },
        ],
        nonce,
        timestamp: 1_700_000_000_000 + nonce,
        transaction_fee: {
            network_fee: options.legacyAmounts ? 1 : "1",
            rpc_fee: options.legacyAmounts ? 0 : "0",
            additional_fee: options.legacyAmounts ? 0 : "0",
            rpc_address: null,
        },
        gcr_edits: [
            {
                type: "nonce",
                operation: "add",
                account: sender.address,
                amount: 1,
                txhash: "",
                isRollback: false,
            },
        ],
    }
    const hash = createHash("sha256")
        .update(serializeTransactionContent(content, options.hashHeight ?? options.height))
        .digest("hex")
    const signer = options.signer ?? sender
    return {
        hash,
        content,
        signature: {
            type: "ed25519",
            data: edSign(
                null,
                txSignaturePreimage(
                    hash,
                    options.signatureChainId ?? 0,
                    options.signatureChainId !== undefined,
                ),
                signer.privateKey,
            ).toString("hex"),
        },
        ed25519_signature: null,
        status: options.status ?? "confirmed",
        blockNumber: options.height,
        attrs: options.attrs ?? { reference_block: options.height - 1 },
    }
}
