// Direct build path, not the SDK barrel: the barrel loads zK/ffjavascript,
// which crashes inside a validator worker thread. This file is imported by
// txValidator.ts, so it has to stay loadable there.
import { serializeTransactionContent as serializeSdkTransactionContent } from "../../../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"

/**
 * The one serialization a transaction hash is derived from, for every node
 * path that checks or produces a hash: the RPC coherence check, the mempool
 * validator, consensus and node-built transactions.
 *
 * The post-osDenomination shape is the SDK's, because the SDK is what the
 * signer ran when it committed to the hash. A node-side re-implementation
 * that differs on any field (fee keys it drops or reorders, `gcr_edits`
 * amounts it leaves untouched) accepts at one ingress what the other
 * rejects, or admits a transaction whose hash the rest of the network
 * recomputes differently.
 *
 * Pre-fork is the raw `JSON.stringify` the chain has always hashed, so
 * re-syncing history reproduces every stored hash.
 *
 * No shared state, no logger: worker-safe. The fork decision is made by the
 * caller, which knows the height.
 *
 * @param content - Transaction content as received or stored.
 * @param osDenominationActive - Whether `osDenomination` applies at the
 *   height being judged.
 */
export function serializeTxContent(
    content: TransactionContent,
    osDenominationActive: boolean,
): string {
    if (!osDenominationActive) {
        return JSON.stringify(content)
    }
    return serializeSdkTransactionContent(content, true)
}
