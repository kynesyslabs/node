import GCR from "@/libs/blockchain/gcr/gcr"
import Datasource from "@/model/datasource"
import { Validators } from "@/model/entities/Validators"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

/**
 * Phase-0 RPC surface for staking state. The underlying GCR methods already
 * exist in gcr.ts but were node-internal; these wrappers expose them so the
 * SDK (and wallets/explorers) can read validator state.
 */
/**
 * Look up a validator by address, tolerating the `0x` prefix either way.
 * Addresses from the SDK/client may come with or without the prefix; the
 * Validators table stores whatever was in `tx.content.from` (which SDK
 * sign() normalizes to 0x-prefixed). Try both so the handler is client-
 * format-agnostic.
 */
async function lookupValidator(address: string) {
    const direct = await GCR.getGCRValidatorStatus(address)
    if (direct) return direct
    const flipped = address.startsWith("0x")
        ? address.slice(2)
        : "0x" + address
    return GCR.getGCRValidatorStatus(flipped)
}

export const validatorHandlers: Record<string, NodeCallHandler> = {
    getValidatorInfo: async (data, response) => {
        const address = extractAddress(data)
        if (!address) {
            response.result = 400
            response.response = { error: "address required" }
            return response
        }
        const validator = await lookupValidator(address)
        response.response = validator ? serializeValidator(validator) : null
        return response
    },

    getValidators: async (data, response) => {
        const blockNumber = extractBlockNumber(data)
        try {
            const validators =
                (await GCR.getGCRValidatorsAtBlock(blockNumber)) as Validators[]
            response.response = validators.map(serializeValidator)
        } catch (e) {
            log.error(
                "validatorHandlers",
                `getValidators error: ${(e as Error)?.message}`,
            )
            response.result = 500
            response.response = { error: "failed to load validators" }
        }
        return response
    },

    getStakedAmount: async (data, response) => {
        const address = extractAddress(data)
        if (!address) {
            response.result = 400
            response.response = { error: "address required" }
            return response
        }
        const validator = await lookupValidator(address)
        if (!validator) {
            response.response = "0"
            return response
        }
        response.response = (validator.staked_amount ?? "0").toString()
        return response
    },
}

function extractAddress(data: unknown): string | null {
    if (typeof data === "string") return data
    if (data && typeof data === "object") {
        const candidate =
            (data as { address?: unknown }).address ??
            (data as { publicKey?: unknown }).publicKey
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate
        }
    }
    return null
}

function extractBlockNumber(data: unknown): number | null {
    if (typeof data === "number") return data
    if (data && typeof data === "object") {
        const candidate = (data as { blockNumber?: unknown }).blockNumber
        if (typeof candidate === "number") return candidate
    }
    return null
}

function serializeValidator(v: Validators) {
    return {
        address: v.address,
        status: v.status,
        connectionUrl: v.connection_url,
        stakedAmount: v.staked_amount ?? "0",
        firstSeen: v.first_seen,
        validAt: v.valid_at,
        unstakeRequestedAt: v.unstake_requested_at,
        unstakeAvailableAt: v.unstake_available_at,
    }
}
