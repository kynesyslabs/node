import { In } from "typeorm"
import { dataSource } from "src/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

export interface TipAccount {
    balance: bigint
    nonce: bigint
}

/**
 * Balances and nonces at the tip, read only: an account without a row reads
 * as balance 0, nonce 0, as block apply creates it. A member must not create
 * gcr_main rows outside a block, or its native table hash differs from every
 * other node's.
 */
export async function readTipAccounts(accounts: Iterable<string>): Promise<Map<string, TipAccount>> {
    const keys = [...new Set(accounts)]
    const out = new Map<string, TipAccount>()
    for (const key of keys) out.set(key, { balance: 0n, nonce: 0n })
    if (keys.length === 0) return out
    const rows = await dataSource.getRepository(GCRMain).find({
        where: { pubkey: In(keys) },
        select: { pubkey: true, balance: true, nonce: true },
    })
    for (const row of rows) {
        out.set(row.pubkey, { balance: BigInt(row.balance), nonce: BigInt(row.nonce) })
    }
    return out
}
