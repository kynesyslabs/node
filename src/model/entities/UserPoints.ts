import {
    Entity,
    Column,
    PrimaryColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from "typeorm"

@Entity()
export class UserPointsEntity {
    @PrimaryColumn()
    userId: string

    @Column({ type: "integer", default: 0 })
    totalPoints: number

    @Column({ type: "jsonb", default: {} })
    breakdown: {
        identityCreation: number
        web3Wallets: number
        socialAccounts: number
    }

    @Column({ type: "jsonb", default: [] })
    linkedWallets: string[]

    @Column({ type: "jsonb", default: {} })
    linkedSocials: {
        twitter?: string
        github?: string
        discord?: string
    }

    @Column()
    reputationLevel: string

    @CreateDateColumn()
    createdAt: Date

    @UpdateDateColumn()
    updatedAt: Date
}
