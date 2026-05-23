import {
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"
import type { StoredIdentities } from "../types/IdentityTypes"
import { bigintNumericTransformer } from "../transformers"
// Define the shape of your JSON data

@Entity("gcr_main")
@Index("idx_gcr_main_pubkey", ["pubkey"])
export class GCRMain {
    @PrimaryColumn({ type: "text", name: "pubkey" })
    pubkey: string
    @Column({ type: "integer", name: "nonce" })
    nonce: number
    /**
     * Account balance in the active denomination (DEM pre-fork, OS
     * post-fork). Stored as Postgres `numeric(38, 0)` (integer-only,
     * arbitrary precision up to 38 decimal digits) so the osDenomination
     * migration's `balance * 10^9` UPDATE cannot overflow signed 64-bit
     * AND the column-type itself rejects fractional writes from a
     * malformed raw SQL caller (myc#85). 38 digits comfortably covers
     * post-fork OS magnitudes up to ~1e27.
     *
     * Driver returns `numeric` as a string; the transformer converts to
     * `bigint` at the ORM boundary so the application-level type stays
     * `bigint`. Raw `entityManager.query` calls bypass the transformer
     * and must coerce via `BigInt(row.balance)` explicitly.
     */
    @Column({
        type: "numeric",
        name: "balance",
        precision: 38,
        scale: 0,
        default: "0",
        transformer: bigintNumericTransformer,
    })
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
                telegram: number
            }
            udDomains?: { [domain: string]: number } // Optional for backward compatibility with historical records
            referrals: number
            demosFollow: number
            weeklyChallenge?: Array<{
                date: string
                points: number
            }>
            nomisScores: { [chain: string]: number }
            humanPassport?: number
            ethosScores?: { [chain: string]: number }
            zkAttestation?: Array<{
                date: string
                points: number
                nullifier: string
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
