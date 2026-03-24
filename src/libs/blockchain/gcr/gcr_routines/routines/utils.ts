import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { Repository } from "typeorm"
import log from "@/utilities/logger"

/**
 * Safe wrapper for GCR repository saves.
 * Logs errors and returns failure result instead of crashing.
 */
export async function safeGCRSave(
    repository: Repository<GCRMain>,
    gcr: GCRMain,
    operation: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        await repository.save(gcr)
        return { success: true }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error(`[GCR] Database save failed during ${operation}`, {
            error: errorMessage,
            pubkey: gcr.pubkey?.substring(0, 16),
        })
        return { success: false, error: `Database error: ${errorMessage}` }
    }
}

export async function isFirstConnection(
    type:
        | "twitter"
        | "github"
        | "web3"
        | "telegram"
        | "discord"
        | "ud"
        | "nomis"
        | "humanpassport"
        | "ethos",
    data: {
        userId?: string // for twitter/github/discord
        chain?: string // for web3
        subchain?: string // for web3
        address?: string // for web3/humanpassport
        domain?: string // for ud
    },
    gcrMainRepository: Repository<GCRMain>,
    currentAccount?: string,
): Promise<boolean> {
    if (type === "humanpassport") {
        const result = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(
                "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'humanpassport', '[]'::jsonb)) AS hp WHERE LOWER(hp->>'address') = LOWER(:address))",
                { address: data.address },
            )
            .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
            .getOne()

        return !result
    }

    if (type !== "web3" && type !== "ud" && type !== "nomis" && type !== "ethos") {
        // Handle web2 identity types: twitter, github, telegram, discord
        const queryTemplate = `
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->'${type}', '[]'::jsonb)) as ${type}_id WHERE ${type}_id->>'userId' = :userId)
        `

        const result = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(queryTemplate, { userId: data.userId })
            .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
            .getOne()

        /**
         * Return true if no account has this userId
         */
        return !result
    } else if (type === "ud") {
        /**
         * Check if this UD domain exists anywhere
         */
        const result = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(
                "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'ud', '[]'::jsonb)) AS ud_id WHERE LOWER(ud_id->>'domain') = LOWER(:domain))",
                { domain: data.domain },
            )
            .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
            .getOne()

        /**
         * Return true if no account has this domain
         */
        return !result
    } else {
        /**
         * For web3 wallets, check if this address exists in any account for this chain/subchain
         */
        const addressToCheck =
            data.chain === "evm" ? data.address.toLowerCase() : data.address

        const rootKey = type === "web3" ? "xm" : type === "ethos" ? "ethos" : "nomis"

        const result = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(
                `
                EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                        COALESCE(gcr.identities->:rootKey->:chain->:subchain, '[]'::jsonb)
                    ) AS item
                    WHERE item->>'address' = :address
                )
                `,
                {
                    rootKey,
                    chain: data.chain,
                    subchain: data.subchain,
                    address: addressToCheck,
                },
            )
            .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
            .getOne()

        /**
         * Return true if this is the first connection
         */
        return !result
    }
}

export function normalizeNomisAddress(
    chain: string,
    address: string,
): string {
    if (chain === "evm") {
        return address.trim().toLowerCase()
    }

    return address.trim()
}

export function normalizeEthosAddress(
    chain: string,
    address: string,
): string {
    if (chain === "evm") {
        return address.trim().toLowerCase()
    }

    return address.trim()
}
