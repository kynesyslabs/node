import readGCRForUser, { type ReadAccount } from "@/libs/blockchain/gcr/gcr_routines/readGCRForUser"
import {
    EthosWalletIdentity,
    SavedEthosIdentity,
} from "@/model/entities/types/IdentityTypes"
import { EthosApiClient } from "../tools/ethos"

export type EthosIdentitySummary = EthosWalletIdentity

export interface EthosImportOptions {
    chain?: string
    subchain?: string
}

export class EthosIdentityProvider {
    static async getWalletScore(
        pubkey: string,
        walletAddress: string,
        options: EthosImportOptions = {},
    ): Promise<SavedEthosIdentity> {
        const chain = options.chain || "evm"
        const subchain = options.subchain || "mainnet"
        const normalizedWallet = this.normalizeAddress(walletAddress, chain)

        const account = await readGCRForUser(pubkey)

        this.assertWalletLinked(account, chain, subchain, normalizedWallet)

        // Always the live score, even for a wallet already linked: a wallet
        // signs this into its assign, and admission compares it with what
        // Ethos reports now, so a stored score could never pass a refresh.
        const apiClient = EthosApiClient.getInstance()
        const payload = await apiClient.getScore(normalizedWallet)

        return {
            address: normalizedWallet,
            score: payload.score,
            profileId: payload.profileId,
            lastSyncedAt: new Date().toISOString(),
            metadata: {
                displayName: payload.displayName,
                username: payload.username,
            },
        }
    }

    static async listIdentities(
        pubkey: string,
    ): Promise<EthosIdentitySummary[]> {
        const account = await readGCRForUser(pubkey)
        return this.flattenIdentities(account)
    }

    private static assertWalletLinked(
        account: ReadAccount,
        chain: string,
        subchain: string,
        walletAddress: string,
    ) {
        const normalizedWallet = this.normalizeAddress(walletAddress, chain)
        const linked =
            account.identities?.xm?.[chain]?.[subchain]?.some(identity => {
                const stored = this.normalizeAddress(identity.address, chain)
                return stored === normalizedWallet
            }) || false

        if (!linked) {
            throw new Error("Wallet is not linked to this account")
        }
    }

    private static flattenIdentities(
        account: ReadAccount,
    ): EthosIdentitySummary[] {
        const summaries: EthosIdentitySummary[] = []
        const ethosIdentities = account.identities?.ethos || {}

        Object.entries(ethosIdentities).forEach(([chain, subchains]) => {
            Object.entries(subchains).forEach(([subchain, identities]) => {
                identities.forEach(identity => {
                    summaries.push({
                        ...identity,
                        chain,
                        subchain,
                    })
                })
            })
        })

        return summaries
    }

    private static normalizeAddress(address: string, chain: string): string {
        if (!address) {
            throw new Error("Wallet address is required")
        }

        if (chain === "evm") {
            return address.trim().toLowerCase()
        }

        return address.trim()
    }
}
