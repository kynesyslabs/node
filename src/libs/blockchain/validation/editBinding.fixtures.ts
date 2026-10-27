/**
 * Transactions for the edit-binding tests, built by the real SDK signer so
 * their edits and amounts are the ones a peer receives. The SDK's questions
 * to the connected node (nonce, fork status, fee parameters) are answered
 * locally; nothing here touches a network.
 */

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

export const OS = 1_000_000_000n
export const PEER = "0x" + "cd".repeat(32)
export const VICTIM = "0x" + "9a".repeat(32)

let sdkPostFork = true
export const demos: any = new Demos()
await demos.connectWalletFromPrivateKey("0x" + "11".repeat(32), { algorithm: "ed25519" })
demos.getAddressNonce = async () => 7
demos._isPostForkCached = async () => sdkPostFork
demos._assertAmountAcceptableOnTargetNode = async () => {}
demos._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 0 })
demos._chainIdCached = async () => "devnet"
demos._isSignatureDomainActiveCached = async () => false

export const SENDER: string = demos.getAddress()

let confirmed: Transaction | null = null
demos.confirm = async (tx: Transaction) => {
    confirmed = tx
    return { response: { data: { transaction: tx } } }
}

/** The signed transaction an identity builder hands to `confirm`. */
export async function viaConfirm(run: () => Promise<unknown>): Promise<Transaction> {
    confirmed = null
    await run()
    if (confirmed === null) throw new Error("the builder did not confirm a transaction")
    return confirmed
}

/** A transaction with a hand-made payload, signed by the real signer. */
export async function handMade(type: string, data: unknown, to?: string): Promise<Transaction> {
    const tx = DemosTransactions.empty()
    tx.content.type = type as never
    tx.content.to = to ?? SENDER
    tx.content.nonce = 8
    tx.content.timestamp = Date.now()
    tx.content.data = [type, data] as never
    return await demos.sign(tx)
}

/** What a peer receives: the signed transaction after a JSON round trip. */
export function onTheWire<T>(tx: T): T {
    return JSON.parse(JSON.stringify(tx)) as T
}

/** Puts the chain tip and the SDK on one side of the osDenomination fork. */
export function chainIs(postFork: boolean): void {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = postFork ? 0 : null
    getSharedState.lastBlockNumber = 100
    sdkPostFork = postFork
}
