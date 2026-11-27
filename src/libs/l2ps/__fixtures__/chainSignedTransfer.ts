/**
 * L2PS transfers as an SDK client sends them: the inner native send is built
 * and signed by the SDK's own `buildSettledL2PSTransfer` / `Demos.sign`, then
 * sealed with a real `L2PS.encryptTx`. The signer's questions to its node
 * (nonce, fork status, chain id, fee parameters) are answered locally.
 */

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { L2PS, buildSettledL2PSTransfer } from "@kynesyslabs/demosdk/l2ps"
import type { L2PSTransaction, Transaction } from "@kynesyslabs/demosdk/types"

export const OS = 1_000_000_000n
/** Fee of a native send when network, RPC and additional fee are 1 DEM each. */
export const NATIVE_FEE = 3n * OS
export const RECEIVER = "0x" + "cd".repeat(32)

/** What the signer's node reports: whether signatureDomain is active, and its chain id. */
export interface SignerView {
    domain: boolean
    chainId: number
}

/** An ed25519 wallet whose node reports `view`, past osDenomination. */
export async function signer(view: SignerView, seed = "0x" + "41".repeat(32)): Promise<any> {
    const demos: any = new Demos()
    await demos.connectWalletFromPrivateKey(seed, { algorithm: "ed25519" })
    demos.getAddressNonce = async () => 7
    demos.getL2PSNonce = async () => 4
    demos.getLastBlockNumber = async () => 100
    demos._isPostForkCached = async () => true
    demos._assertAmountAcceptableOnTargetNode = async () => {}
    demos._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 1 })
    demos._chainIdCached = async () => view.chainId
    demos._isSignatureDomainActiveCached = async () => view.domain
    demos.getNetworkInfo = async () => ({
        chainId: view.chainId,
        forks: { osDenomination: { activated: true }, signatureDomain: { activated: view.domain } },
    })
    return demos
}

/** A subnet with fresh keys whose uid is `uid`. */
export async function subnet(uid: string): Promise<L2PS> {
    const l2ps = await L2PS.create()
    l2ps.setConfig({ uid } as never)
    return l2ps
}

/**
 * A settlement transfer as SDK 4.0.24 builds it. The settlement signature
 * binds `settlementChainId`, which defaults to the signer's chain id; the
 * transaction signature follows the signer's view of signatureDomain.
 */
export async function settledTransfer(
    demos: any,
    l2psUid: string,
    options: { nonce?: number; amount?: bigint; settlementChainId?: number } = {},
): Promise<Transaction> {
    return await buildSettledL2PSTransfer(demos, {
        to: RECEIVER,
        amount: options.amount ?? 5n * OS,
        l2psUid,
        fee: NATIVE_FEE,
        nonce: options.nonce ?? 5,
        chainId: options.settlementChainId ?? (await demos._chainIdCached()),
    })
}

/** A plain native send, as a pre-settlement L2PS transfer is. */
export async function plainSend(demos: any, amount = 1n): Promise<Transaction> {
    return await DemosTransactions.pay(RECEIVER, amount, demos)
}

/** `inner` sealed for `l2ps`, as a peer receives the envelope. */
export async function sealed(l2ps: L2PS, inner: Transaction): Promise<L2PSTransaction> {
    return JSON.parse(JSON.stringify(await l2ps.encryptTx(inner))) as L2PSTransaction
}
