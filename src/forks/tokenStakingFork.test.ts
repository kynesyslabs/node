/**
 * Mainnet launches with token staking off: the validators are the genesis
 * list, and a stake or unstake is refused at intake and at apply until the
 * `tokenStaking` fork opens it by network upgrade. `tokenStakingGate` is the
 * fork a mainnet genesis schedules; a genesis that declares neither, as a
 * running testnet's does, keeps staking open and its fork schedule unchanged.
 *
 * The transactions come from the real SDK signer.
 */

import { describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"

// Block apply reads validator rows and network upgrades: none are stored.
const repoFor = (name: string) => ({
    target: { name },
    create: (row: unknown) => ({ ...(row as object) }),
    findOneBy: async () => null,
    find: async () => [],
    save: async (row: unknown) => row,
})
const fakeDataSource = {
    getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const {
    SENDER_BALANCE,
    chainTip,
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubBlockApply,
} = await import("@/libs/blockchain/testSupport/forkGates")
mockChainAndLogger()

const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default
const { verifyAdmissionEdits, verifyRpcEdits } = await import("@/libs/blockchain/validation/editBinding")
const { PEER, SENDER, demos, onTheWire } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig } = await import("./forkConfig")
const { loadForkConfigFromGenesis } = await import("./loadForkConfig")
const { TOKEN_STAKING_REFUSAL, carriesTokenStaking, isTokenStakingEdit, tokenStakingOpen, tokenStakingRefusal } = await import("./tokenStakingGate")
const { forkScheduleDigest } = await import("@/libs/peer/routines/forkScheduleAgreement")
const { getSharedState } = await import("@/utilities/sharedState")
const { DEFAULT_MIN_VALIDATOR_STAKE } = await import("@/features/staking/constants")

restoreForkConfigAfterEach()

const MIN = BigInt(DEFAULT_MIN_VALIDATOR_STAKE)

const stake = async () =>
    onTheWire(await DemosTransactions.stake(MIN.toString(), "https://node.example", demos))
const unstake = async () => onTheWire(await DemosTransactions.unstake(demos))
const pay = async () => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

/** A pay carrying an exit edit for the sender, with `rollback` spread over it. */
const payWithExit = async (rollback: Record<string, unknown>) => {
    const tx = await pay()
    ;(tx.content.gcr_edits as unknown as Array<Record<string, unknown>>).push({
        type: "validatorStake",
        operation: "exit",
        account: SENDER,
        amount: MIN.toString(),
        connectionUrl: "https://node.example",
        txhash: "",
        ...rollback,
    })
    return tx
}

/** The mainnet forks with stakeApplyChecks on, and the two staking forks at the given heights. */
const forks = (gate: number | null, staking: number | null) =>
    mainnetForks({ stakeApplyChecks: 0, tokenStakingGate: gate, tokenStaking: staking })

const readJson = (path: string) => {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed
}

describe("token staking type checks", () => {
    it("ignores non-string edit types", () => {
        for (const type of [{}, 1, null]) {
            expect(isTokenStakingEdit({ type, operation: "stake" })).toBe(false)
        }
    })

    it("ignores non-string transaction types", () => {
        for (const type of [{}, 1, null]) {
            expect(carriesTokenStaking({ content: { type, gcr_edits: [] } })).toBe(false)
        }
    })
})

describe("token staking fork config", () => {
    it("leaves both forks unscheduled by default, so staking stays open", () => {
        expect(DEFAULT_FORK_CONFIG.tokenStakingGate.activationHeight).toBeNull()
        expect(DEFAULT_FORK_CONFIG.tokenStaking.activationHeight).toBeNull()
        getSharedState.forkConfig = cloneDefaultForkConfig()
        expect(tokenStakingOpen(0)).toBe(true)
        expect(tokenStakingOpen(1_000_000)).toBe(true)
    })

    it("keeps staking open on the testnet genesis, which declares neither, with the schedule digest it had", () => {
        const testnet = readJson("data/genesis.json")
        expect(testnet.forks.tokenStakingGate).toBeUndefined()
        expect(testnet.forks.tokenStaking).toBeUndefined()

        getSharedState.forkConfig = cloneDefaultForkConfig()
        loadForkConfigFromGenesis(testnet)
        expect(tokenStakingOpen(0)).toBe(true)
        expect(tokenStakingOpen(1_000_000)).toBe(true)

        // What a build without the two forks reports for the same genesis.
        const loaded = getSharedState.forkConfig as unknown as Record<string, any>
        const { tokenStakingGate: _gate, tokenStaking: _staking, ...without } = loaded
        expect(forkScheduleDigest(loaded, getSharedState.chainId)).toBe(
            forkScheduleDigest(without, getSharedState.chainId),
        )
    })

    it("is closed from block 0 by the mainnet template, which leaves tokenStaking unscheduled", () => {
        const template = readJson("docs/mainnet/genesis.template.json")
        expect(template.forks.tokenStakingGate).toEqual({ activationHeight: 0 })
        expect(template.forks.tokenStaking).toEqual({ activationHeight: null })

        getSharedState.forkConfig = cloneDefaultForkConfig()
        loadForkConfigFromGenesis({
            forks: {
                tokenStakingGate: template.forks.tokenStakingGate,
                tokenStaking: template.forks.tokenStaking,
            },
        })
        expect(tokenStakingOpen(0)).toBe(false)
        expect(tokenStakingOpen(1_000_000)).toBe(false)
    })

    it("opens from the height tokenStaking is pinned at", () => {
        getSharedState.forkConfig = cloneDefaultForkConfig()
        loadForkConfigFromGenesis({
            forks: { tokenStakingGate: { activationHeight: 0 }, tokenStaking: { activationHeight: 500 } },
        })
        expect(tokenStakingOpen(499)).toBe(false)
        expect(tokenStakingOpen(500)).toBe(true)
    })
})

describe("intake", () => {
    it("pool admission refuses a stake and an unstake while token staking is closed", async () => {
        forks(0, null)
        for (const tx of [await stake(), await unstake()]) {
            expect(await verifyAdmissionEdits(tx)).toEqual({ ok: false, reason: TOKEN_STAKING_REFUSAL })
        }
    })

    it("RPC submission refuses them too", async () => {
        forks(0, null)
        for (const tx of [await stake(), await unstake()]) {
            expect(await verifyRpcEdits(tx)).toEqual({ ok: false, reason: TOKEN_STAKING_REFUSAL })
        }
    })

    it("refuses a stake edit carried by a transaction of another type", async () => {
        forks(0, null)
        const tx = await pay()
        ;(tx.content.gcr_edits as unknown as Array<Record<string, unknown>>).push({
            type: "validatorStake",
            operation: "stake",
            account: SENDER,
            amount: MIN.toString(),
            connectionUrl: "https://node.example",
            isRollback: false,
            txhash: "",
        })
        expect(await verifyAdmissionEdits(tx)).toEqual({ ok: false, reason: TOKEN_STAKING_REFUSAL })
    })

    it("admits other transactions while closed", async () => {
        forks(0, null)
        expect(await verifyAdmissionEdits(await pay())).toEqual({ ok: true })
    })

    it("admits a stake and an unstake once tokenStaking is active, and on a chain without the gate", async () => {
        for (const [gate, staking] of [[0, 0], [null, null]] as const) {
            forks(gate, staking)
            for (const tx of [await stake(), await unstake()]) {
                expect(await verifyAdmissionEdits(tx)).toEqual({ ok: true })
            }
        }
    })
})

describe("an exit shipped as a rollback", () => {
    // Apply turns an exit into a stake whenever isRollback is truthy.
    it("is refused while closed for any truthy isRollback", async () => {
        forks(0, null)
        for (const isRollback of [1, "yes", {}]) {
            const tx = await payWithExit({ isRollback })
            expect(tokenStakingRefusal(tx, tokenStakingOpen(chainTip.height))).toBe(TOKEN_STAKING_REFUSAL)
        }
    })

    it("is not refused for a falsy or absent isRollback", async () => {
        forks(0, null)
        for (const rollback of [{ isRollback: false }, { isRollback: 0 }, { isRollback: "" }, {}]) {
            const tx = await payWithExit(rollback)
            expect(tokenStakingRefusal(tx, tokenStakingOpen(chainTip.height))).toBeNull()
        }
    })
})

describe("block apply", () => {
    const block = stubBlockApply(handleGCR)
    const sender = () => block.caches.accounts.get(SENDER) as any
    const reset = (balance: bigint) => {
        sender().nonce = 7
        sender().balance = balance
        delete (block.caches as { validators?: unknown }).validators
    }

    it("fails a stake and an unstake while closed, with no balance, nonce or validator row change", async () => {
        forks(0, null)
        for (const tx of [await stake(), await unstake()]) {
            reset(SENDER_BALANCE)
            expect(await block.refused([tx])).toEqual([tx.hash])
            const out = await block.apply([tx])

            expect(out.failedTxs).toEqual([tx.hash])
            expect(out.successfulTxs).toEqual([])
            expect(sender().nonce).toBe(7)
            expect(sender().balance).toBe(SENDER_BALANCE)
            expect(block.caches.validators?.get(SENDER)).toBeUndefined()
        }
    })

    it("fails an exit with isRollback 1 while closed, before stakeApplyChecks and editBinding, with no validator row", async () => {
        mainnetForks({ editBinding: null, stakeApplyChecks: null, tokenStakingGate: 0, tokenStaking: null })
        reset(SENDER_BALANCE)
        const tx = await payWithExit({ isRollback: 1 })
        expect(await block.refused([tx])).toEqual([tx.hash])
        const out = await block.apply([tx])

        expect(out.failedTxs).toEqual([tx.hash])
        expect(out.successfulTxs).toEqual([])
        expect(block.caches.validators?.get(SENDER)).toBeUndefined()
    })

    it("refuses it before apply, from the tip, next to a transaction the block applies", async () => {
        forks(0, null)
        const bad = await stake()
        const good = await pay()
        expect(await block.refused([bad, good])).toEqual([bad.hash])
    })

    it("opens with tokenStaking at H from block H + 1, judged from the tip like the other apply gates", async () => {
        forks(0, 101)
        const tx = await stake()
        expect(await block.refused([tx])).toEqual([tx.hash])
        chainTip.height = 101
        expect(await block.refused([tx])).toEqual([])
    })

    it("after the upgrade applies a stake as stakeApplyChecks does on a chain without the gate", async () => {
        const tx = await stake()
        const outcome = async (gate: number | null, staking: number | null) => {
            forks(gate, staking)
            reset(2n * MIN)
            const out = await block.apply([tx])
            return {
                out,
                balance: sender().balance,
                nonce: sender().nonce,
                row: structuredClone(block.caches.validators?.get(SENDER)),
            }
        }

        const opened = await outcome(0, 100)
        expect(opened.out.successfulTxs).toEqual([tx.hash])
        expect(BigInt(opened.balance)).toBeLessThanOrEqual(MIN)
        expect(opened.row).toMatchObject({
            status: "2",
            staked_amount: MIN.toString(),
            bonded_amount: MIN.toString(),
        })
        expect(await outcome(null, null)).toEqual(opened)
    })
})
