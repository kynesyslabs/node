import Transaction from "@/libs/blockchain/transaction"
import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import Mempool from "@/libs/blockchain/mempool"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import { generateGcrEdits } from "@/libs/blockchain/validation/generateGcrEdits"
import { calculateFeeBreakdown } from "@/libs/blockchain/routines/calculateCurrentGas"
import { serializeTransactionContent, txSignaturePreimageForPendingBlock } from "@/forks"
import { getSharedState } from "@/utilities/sharedState"
import { Hashing, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

/**
 * An `l2ps_hash_update` signed by this node's identity, built the way the
 * node builds its other transactions (as the signalling server does): the
 * edits and fee an SDK client would ship, hashed with the fork-aware
 * serializer at the tip and signed over the chain's signature preimage.
 *
 * The SDK builder needs a connected wallet and an RPC this process never
 * connects, which is why every hash update on the launch rehearsal failed
 * with "Wallet not connected".
 */
export async function buildNodeHashUpdate(
    l2psUid: string,
    consolidatedHash: string,
    transactionCount: number,
): Promise<Transaction> {
    const publicKey = getSharedState.keypair?.publicKey
    if (!(publicKey instanceof Uint8Array)) {
        throw new Error("the node identity is not loaded")
    }
    const identity = uint8ArrayToHex(publicKey).toLowerCase()

    const referenceBlock = await Chain.getLastBlockNumber()
    const nonce = (await highestNonce(identity)) + 1
    const timestamp = Date.now()

    const tx = new Transaction()
    tx.hash = ""
    tx.content = {
        ...tx.content,
        type: "l2ps_hash_update",
        from: identity,
        from_ed25519_address: identity,
        // Self-directed, as the SDK builds it.
        to: identity,
        amount: 0,
        nonce,
        timestamp,
        data: [
            "l2ps_hash_update",
            {
                l2ps_uid: l2psUid,
                consolidated_hash: consolidatedHash,
                transaction_count: transactionCount,
                timestamp,
            },
        ] as never,
        gcr_edits: [],
    }
    // Admission binds the shipped fee to this breakdown and regenerates the
    // edits from the body, so both come from the same functions it uses.
    const fee = await calculateFeeBreakdown(tx)
    tx.content.transaction_fee = {
        network_fee: fee.network_fee,
        rpc_fee: fee.rpc_fee,
        additional_fee: fee.additional_fee,
        rpc_address: null,
    }
    tx.content.gcr_edits = await generateGcrEdits(tx as never)

    const serialized = serializeTransactionContent(tx.content as never, referenceBlock)
    tx.hash = Hashing.sha256(serialized)
    // The stored body is the wire shape the hash covers.
    tx.content = JSON.parse(serialized)
    const signature = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        txSignaturePreimageForPendingBlock(tx.hash),
    )
    tx.signature = {
        type: getSharedState.signingAlgorithm,
        data: uint8ArrayToHex(signature.signature),
    } as never
    return tx
}

/**
 * The account nonce, or the highest one this identity already has pending:
 * a hash update every cycle must not reuse a nonce the pool holds.
 */
async function highestNonce(identity: string): Promise<number> {
    let highest = Number(await GCR.getAccountNonce(identity))
    for (const pending of await Mempool.listPendingBySenders([identity])) {
        const value = Number(pending.nonce)
        if (Number.isSafeInteger(value) && value > highest) highest = value
    }
    return highest
}
