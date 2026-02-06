import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
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

        const account = await ensureGCRForUser(pubkey)

        this.assertWalletLinked(account, chain, subchain, normalizedWallet)

        const existing = this.getExistingIdentity(
            account,
            chain,
            subchain,
            normalizedWallet,
        )

        if (existing) {
            return existing
        }

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
        const account = await ensureGCRForUser(pubkey)
        return this.flattenIdentities(account)
    }

    private static assertWalletLinked(
        account: GCRMain,
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
            throw new Error(
                `Wallet ${walletAddress} is not linked to ${account.pubkey} on ${chain}:${subchain}`,
            )
        }
    }

    private static flattenIdentities(
        account: GCRMain,
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

    private static getExistingIdentity(
        account: GCRMain,
        chain: string,
        subchain: string,
        walletAddress: string,
    ): SavedEthosIdentity | undefined {
        const ethosIdentities = account.identities?.ethos || {}
        const normalizedWallet = this.normalizeAddress(walletAddress, chain)
        return ethosIdentities?.[chain]?.[subchain]?.find(identity => {
            const storedAddress = this.normalizeAddress(identity.address, chain)
            return storedAddress === normalizedWallet
        })
    }
}
