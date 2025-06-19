import { Column, Entity, PrimaryColumn } from "typeorm"
import type { StoredIdentities } from "../types/IdentityTypes"
// Define the shape of your JSON data

@Entity("gcr_main")
export class GCRMain {
    @PrimaryColumn({ type: "text", name: "pubkey" })
    pubkey: string
    @Column({ type: "jsonb", name: "assignedTxs" })
    assignedTxs: string[]
    @Column({ type: "integer", name: "nonce" })
    nonce: number
    @Column({ type: "bigint", name: "balance" })
    balance: bigint
    @Column({ type: "jsonb", name: "identities" })
    identities: StoredIdentities
    @Column({ type: "jsonb", name: "points", default: () => "'{}'" })
    points: {
        totalPoints: number
        breakdown: {
            web3Wallets: { [chain: string]: number }
            socialAccounts: {
                twitter: number
                github: number
                discord: number
            }
            referrals: number
        }
        lastUpdated: Date
    }
    @Column({ type: "jsonb", name: "referralInfo", default: () => "'{}'" })
    referralInfo: {
        totalReferrals: number
        referredBy?: string
        referralCode: string
        referrals: Array<{
            referredUserId: string
            referredAt: string
            pointsAwarded: number
        }>
    }
}
