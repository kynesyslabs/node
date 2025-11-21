import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
import log from "@/utilities/logger"
import { NomisWalletIdentity } from "@/model/entities/types/IdentityTypes"
import GCRIdentityRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines"
import { GCREditIdentity } from "@kynesyslabs/demosdk/types"
import {
    NomisApiClient,
    NomisScoreRequestOptions,
    NomisWalletScorePayload,
} from "../tools/nomis"

export type NomisIdentitySummary = NomisWalletIdentity

export interface NomisImportOptions extends NomisScoreRequestOptions {
    chain?: string
    subchain?: string
    forceRefresh?: boolean
}

export class NomisIdentityProvider {
    static async getWalletScore(
        pubkey: string,
        walletAddress: string,
        options: NomisImportOptions = {},
    ): Promise<NomisIdentitySummary> {
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
            if (options.forceRefresh) {
                log.info(
                    `[NomisIdentityProvider] Skipping refresh for ${normalizedWallet} (chain=${chain}/${subchain}) until identity removal`,
                )
            }

            return existing
        }

        const apiClient = NomisApiClient.getInstance()
        const payload = await apiClient.getWalletScore(normalizedWallet, options)

        const identityRecord = this.buildIdentityRecord(
            payload,
            chain,
            subchain,
            normalizedWallet,
            options,
        )

        return identityRecord
    }

    static async listIdentities(pubkey: string): Promise<NomisIdentitySummary[]> {
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

    private static buildIdentityRecord(
        payload: NomisWalletScorePayload,
        chain: string,
        subchain: string,
        walletAddress: string,
        options: NomisScoreRequestOptions,
    ): NomisWalletIdentity {
        return {
            chain,
            subchain,
            address: walletAddress,
            score: payload.score,
            scoreType: payload.scoreType ?? options.scoreType ?? 0,
            mintedScore: payload.mintData?.mintedScore ?? null,
            lastSyncedAt: new Date().toISOString(),
            metadata: {
                referralCode: payload.referralCode,
                referrerCode: payload.referrerCode,
                deadline:
                    payload.mintData?.deadline ?? payload.migrationData?.deadline,
                nonce: options.nonce,
            },
        }
    }

    private static flattenIdentities(account: GCRMain): NomisIdentitySummary[] {
        const summaries: NomisIdentitySummary[] = []
        const nomisIdentities = account.identities.nomis || {}

        Object.entries(nomisIdentities).forEach(([chain, subchains]) => {
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
    ): NomisWalletIdentity | undefined {
        const nomisIdentities = account.identities.nomis || {}
        const normalizedWallet = this.normalizeAddress(walletAddress, chain)
        return nomisIdentities?.[chain]?.[subchain]?.find(identity => {
            const storedAddress = this.normalizeAddress(identity.address, chain)
            return storedAddress === normalizedWallet
        })
    }
}
