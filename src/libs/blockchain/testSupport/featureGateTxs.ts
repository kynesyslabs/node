import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary/service"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { OS, PEER, chainIs, demos, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"

/**
 * The transactions the launch feature gates (`l2psGate`, `tlsnDisabled`)
 * refuse, as a peer receives them from the real SDK signer and builders.
 */

export const l2psEncrypted = async (): Promise<Transaction> =>
    onTheWire(await handMade("l2psEncryptedTx", { l2ps_uid: "net", encrypted_data: "x", tag: "t", original_hash: "ab".repeat(32) }))
export const l2psSubnet = async (): Promise<Transaction> =>
    onTheWire(await handMade("subnet", { l2ps_uid: "net", encrypted_data: "x" }))
export const l2psHashUpdate = async (): Promise<Transaction> =>
    onTheWire(await handMade("l2ps_hash_update", { l2ps_uid: "net", consolidated_hash: "cd".repeat(32), transaction_count: 1 }))
export const l2psBatch = async (): Promise<Transaction> =>
    onTheWire(await handMade("l2psBatch", { l2ps_uid: "net", batch_hash: "ef".repeat(32) }))

/** One transaction of each L2PS type. */
export const l2psTxs = async (): Promise<Transaction[]> => [
    await l2psEncrypted(),
    await l2psSubnet(),
    await l2psHashUpdate(),
    await l2psBatch(),
]

const tlsnService = () => {
    demos.connected = true
    return new TLSNotaryService(demos) as any
}
export const tlsnRequest = async (): Promise<Transaction> =>
    onTheWire(await tlsnService().createTlsnRequestTransaction("https://example.com/path", 8))
export const tlsnStore = async (): Promise<Transaction> =>
    onTheWire(await tlsnService().createTlsnStoreTransaction("token-1", "proof-bytes", "onchain", 2n * OS, 8))
export const tlsnTxs = async (): Promise<Transaction[]> => [await tlsnRequest(), await tlsnStore()]

/** A native send, which no feature gate refuses. */
export const pay = async (): Promise<Transaction> => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

/** Post-fork chain at tip 100 with `l2psGate` and `tlsnDisabled` at the given heights (null: dormant). */
export function featureGates(l2psGate: number | null, tlsnDisabled: number | null): void {
    chainIs(true, 0)
    const config = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
    config.l2psGate = { activationHeight: l2psGate }
    config.tlsnDisabled = { activationHeight: tlsnDisabled }
}
