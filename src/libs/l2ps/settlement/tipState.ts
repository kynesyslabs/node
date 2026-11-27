import { In } from "typeorm"
import { dataSource } from "src/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { l2psNonceOf, withL2PSNonce, type L2PSNonces } from "./l2psNonce"

export interface TipAccount {
    balance: bigint
    /** The L2PS nonce in the subnet asked for: settlement never reads the L1 nonce. */
    nonce: bigint
    /** Every subnet's L2PS nonce, for checks that span the subnets of one balance. */
    l2psNonces: L2PSNonces
}

/**
 * Balances and L2PS nonces in `l2psUid` at the tip, read only: an account
 * without a row reads as balance 0, L2PS nonce 0, as block apply creates it.
 * A member must not create gcr_main rows outside a block, or its native
 * table hash differs from every other node's.
 */
export async function readTipAccounts(
    accounts: Iterable<string>,
    l2psUid: string,
): Promise<Map<string, TipAccount>> {
    const keys = [...new Set(accounts)]
    const out = new Map<string, TipAccount>()
    for (const key of keys) out.set(key, { balance: 0n, nonce: 0n, l2psNonces: {} })
    if (keys.length === 0) return out
    const rows = await dataSource.getRepository(GCRMain).find({
        where: { pubkey: In(keys) },
        select: { pubkey: true, balance: true, l2psNonces: true },
    })
    for (const row of rows) {
        out.set(row.pubkey, {
            balance: BigInt(row.balance),
            nonce: BigInt(l2psNonceOf(row, l2psUid)),
            // Rebuilt through own properties: the map's keys came off the wire.
            l2psNonces: copyNonces(row.l2psNonces),
        })
    }
    return out
}

function copyNonces(nonces: unknown): L2PSNonces {
    if (typeof nonces !== "object" || nonces === null) return {}
    let out: L2PSNonces = {}
    for (const uid of Object.keys(nonces)) {
        out = withL2PSNonce(out, uid, l2psNonceOf({ l2psNonces: nonces }, uid))
    }
    return out
}

/** One account's L2PS nonce in `l2psUid` at the tip; 0 for an account without a row. */
export async function readL2PSNonce(account: string, l2psUid: string): Promise<number> {
    const row = await dataSource.getRepository(GCRMain).findOne({
        where: { pubkey: account },
        select: { pubkey: true, l2psNonces: true },
    })
    return l2psNonceOf(row, l2psUid)
}
