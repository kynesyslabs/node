import { beforeAll, describe, expect, it, jest } from "@jest/globals"
import { readFileSync } from "fs"
import { join } from "path"

// The genesis block defines the chain: its tx hash covers from_ed25519_address and the
// allocation list seeds native balances. Both must match the base branch, not the token PR.

const logMock = {
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn() },
}
jest.mock("src/utilities/logger", () => logMock)
jest.mock("@/utilities/logger", () => logMock)
const sharedState = { __esModule: true, getSharedState: { signingAlgorithm: "ed25519" } }
jest.mock("src/utilities/sharedState", () => sharedState)
jest.mock("@/utilities/sharedState", () => sharedState)

class FakeTransaction {
    content: any = { transaction_fee: {} }
    hash = ""
    signature: any = null
    status = ""
    blockNumber = 0
}
class FakeBlock {
    number = 0
    hash = ""
    content: any = { ordered_transactions: [] }
    status = ""
    proposer = ""
    validation_data: any = null
    next_proposer = ""
}
jest.mock("src/libs/blockchain/transaction", () => ({ __esModule: true, default: FakeTransaction }))
jest.mock("src/libs/blockchain/block", () => ({ __esModule: true, default: FakeBlock }))
const addTransaction = jest.fn(async (_tx: any) => undefined)
jest.mock("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { addTransaction } }))
const createAccount = jest.fn(async (_pubkey: string, _user: any) => undefined)
jest.mock("src/libs/blockchain/gcr/handleGCR", () => ({ __esModule: true, default: { createAccount } }))
jest.mock("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: jest.fn(async () => ({ commonValidatorSeed: "seed" })),
}))
jest.mock("src/libs/blockchain/chainBlocks", () => ({ __esModule: true, insertBlock: jest.fn(async () => undefined) }))

// Native allocations added by the token PR (commit 14b403d3), absent from base and stabilisation.
const PR_ADDED_ALLOCATIONS = [
    "0xd8b32426355612a7baf86408b12c9c91fb2eac103e35ad027a2641887321fa49",
    "0xa50a409ce5cad42d1caa88667209a55c67b7060eaae5fa28261066fcd5f7644b",
    "0x2f7fd1d7a747d9d53e9af892086a287d7526bb012b126f6b449802eeff27dab6",
    "0x0b848f50ec9d7e4e019854c2315dfde1fe0308b5dbda1b637475b85fad2433a8",
]

let generateGenesisBlock: typeof import("src/libs/blockchain/chainGenesis")["generateGenesisBlock"]
const genesisData = JSON.parse(readFileSync(join(__dirname, "../../data/genesis.json"), "utf8"))

beforeAll(async () => {
    generateGenesisBlock = (await import("src/libs/blockchain/chainGenesis")).generateGenesisBlock
})

describe("genesis matches the base branch", () => {
    it("genesis tx has an empty from_ed25519_address (base value)", async () => {
        await generateGenesisBlock(genesisData)
        const genesisTx = addTransaction.mock.calls[0][0]
        expect(genesisTx.content.from_ed25519_address).toBe("")
    })

    it("seeds no native balance for the token PR's test allocations", async () => {
        createAccount.mockClear()
        await generateGenesisBlock(genesisData)
        const seeded = createAccount.mock.calls.map(call => call[0])
        expect(seeded).toHaveLength(genesisData.balances.length)
        for (const address of PR_ADDED_ALLOCATIONS) {
            expect(seeded).not.toContain(address)
        }
    })
})
