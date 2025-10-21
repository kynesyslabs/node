import {
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"
import type { StoredIdentities } from "../types/IdentityTypes"
// Define the shape of your JSON data

@Entity("gcr_main")
@Index("idx_gcr_main_pubkey", ["pubkey"])
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
                telegram?: number // Optional for backward compatibility with historical records
            }
            udDomains?: { [domain: string]: number } // Optional for backward compatibility with historical records
            referrals: number
            demosFollow: number
            weeklyChallenge?: Array<{
                date: string
                points: number
            }>
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
    @Column({ type: "boolean", name: "flagged", default: false })
    flagged: boolean
    @Column({ type: "text", name: "flaggedReason", default: "" })
    flaggedReason:
        | "twitter_bot"
        | "evm_no_tx"
        | "solana_no_tx"
        | "web3_no_tx"
        | "only_evm_no_tx"
        | "manualFlag"
        | "referrerFlagged"
        | ""
    @Column({ type: "boolean", name: "reviewed", default: false })
    reviewed: boolean
    @CreateDateColumn({ type: "timestamp", name: "createdAt" })
    createdAt: Date
    @UpdateDateColumn({ type: "timestamp", name: "updatedAt" })
    updatedAt: Date
}
