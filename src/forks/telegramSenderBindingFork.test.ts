/**
 * Under `telegramSenderBinding` a Telegram attestation links only to the
 * account whose key signed its challenge. Before the fork any account could
 * submit an attestation issued to someone else; that stays true at heights
 * below the fork, so old blocks replay the same way.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { verifyWeb2Proof } from "@/libs/abstraction"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import template from "../../docs/mainnet/genesis.template.json"

const OWNER = "0x" + "11".repeat(32)
const OTHER = "0x" + "22".repeat(32)
const BOT = "0x" + "33".repeat(32)

function claim(issuedTo: string) {
    return {
        context: "telegram",
        username: "alice",
        userId: "42",
        proof: {
            payload: {
                telegram_user_id: "42",
                username: "alice",
                challenge: "demos-telegram-challenge",
                signature: "aa".repeat(64),
                public_key: issuedTo,
                timestamp: 1,
                bot_address: BOT,
                group_membership: true,
            },
            signature: { type: "ed25519", data: "bb".repeat(64) },
        },
    } as any
}

describe("telegramSenderBinding", () => {
    let saved: {
        forkConfig: ForkConfigByName
        lastBlockNumber: number
        genesisIdentities: Set<string>
    }
    let pool: ReturnType<typeof spyOn>

    beforeEach(() => {
        saved = {
            forkConfig: getSharedState.forkConfig,
            lastBlockNumber: getSharedState.lastBlockNumber,
            genesisIdentities: getSharedState.genesisIdentities,
        }
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.genesisIdentities = new Set([BOT])
        // Signatures are not under test: both the user's and the bot's verify.
        pool = spyOn(TxValidatorPool, "getInstance").mockReturnValue({
            verify: async () => true,
        } as any)
    })

    afterEach(() => {
        pool.mockRestore()
        getSharedState.forkConfig = saved.forkConfig
        getSharedState.lastBlockNumber = saved.lastBlockNumber
        getSharedState.genesisIdentities = saved.genesisIdentities
    })

    it("ships dormant and is scheduled at 0 by the mainnet genesis template", () => {
        expect(DEFAULT_FORK_CONFIG.telegramSenderBinding.activationHeight).toBeNull()
        expect(
            (template.forks as Record<string, { activationHeight: unknown }>)
                .telegramSenderBinding.activationHeight,
        ).toBe(0)
    })

    it("refuses an attestation issued to another account once active", async () => {
        loadForkConfigFromGenesis({ forks: { telegramSenderBinding: { activationHeight: 10 } } })
        getSharedState.lastBlockNumber = 10
        const r = await verifyWeb2Proof(claim(OTHER), OWNER)
        expect(r.success).toBe(false)
        expect(r.message).toContain("not issued to the sender")
    })

    it("accepts the sender's own attestation once active, in any key spelling", async () => {
        loadForkConfigFromGenesis({ forks: { telegramSenderBinding: { activationHeight: 0 } } })
        getSharedState.lastBlockNumber = 5
        expect((await verifyWeb2Proof(claim(OWNER), OWNER)).success).toBe(true)
        expect((await verifyWeb2Proof(claim(OWNER.slice(2).toUpperCase()), OWNER)).success).toBe(true)
    })

    it("keeps the old rule below the fork height", async () => {
        loadForkConfigFromGenesis({ forks: { telegramSenderBinding: { activationHeight: 10 } } })
        getSharedState.lastBlockNumber = 9
        expect((await verifyWeb2Proof(claim(OTHER), OWNER)).success).toBe(true)
    })
})
