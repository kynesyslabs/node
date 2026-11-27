/**
 * Operations that send a signed transaction (pay, contract_write) carry
 * exactly one payload of the shape their chain's executor decodes. A wrong
 * count or shape is refused before any connection to the target chain.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const { signedPayloadsRefusal } = await import("./checkSignedPayloads")
const multichain = await import("@kynesyslabs/demosdk/xm-localsdk")
const { default: handleContractWrite } = await import(
    "src/features/multichain/routines/executors/contract_write"
)
const { default: handlePayOperation } = await import(
    "src/features/multichain/routines/executors/pay"
)

const evm = (signedPayloads: unknown) => ({ chain: "eth", is_evm: true, task: { signedPayloads } })
const other = (chain: string, signedPayloads: unknown) => ({ chain, is_evm: false, task: { signedPayloads } })

afterEach(() => jest.restoreAllMocks())

describe("signedPayloadsRefusal", () => {
    it("accepts one payload of the chain's shape", () => {
        expect(signedPayloadsRefusal(1, evm(["0xf86b80"]))).toBeNull()
        expect(signedPayloadsRefusal(1, other("aptos", ["00ab"]))).toBeNull()
        expect(signedPayloadsRefusal(1, other("xrpl", [{ tx_blob: "12" }]))).toBeNull()
        expect(signedPayloadsRefusal(1, other("solana", [{ 0: 1 }]))).toBeNull()
        expect(signedPayloadsRefusal(1, other("ton", ["b5ee9c72"]))).toBeNull()
    })

    const bad: Array<[string, unknown, string]> = [
        ["a missing list", evm(undefined), "not a list"],
        ["no payload", evm([]), "expected 1, got 0"],
        ["two payloads", evm(["0x01", "0x02"]), "expected 1, got 2"],
        ["a non-hex EVM payload", evm(["hello"]), "not a hex string"],
        ["an object EVM payload", evm([{ 0: 1 }]), "not a hex string"],
        ["a non-hex Aptos payload", other("aptos", ["zz"]), "not a hex string"],
        ["an empty string", other("ton", ["  "]), "empty"],
        ["an empty object", other("solana", [{}]), "empty"],
        ["a number", other("egld", [5]), "neither"],
        ["null", other("egld", [null]), "neither"],
    ]
    for (const [label, op, reason] of bad) {
        it(`refuses ${label}`, () => {
            expect(signedPayloadsRefusal(1, op as never)).toContain(reason)
        })
    }
})

describe("executors check payloads before connecting", () => {
    it("contract_write refuses a bad payload without creating a client", async () => {
        const create = spyOn(multichain.MULTIVERSX, "create")
        const reply = await handleContractWrite(
            { chain: "egld", subchain: "mainnet", is_evm: false, rpc: "", task: { type: "contract_write", params: null, signedPayloads: [] } },
            0,
        )
        expect(reply).toMatchObject({ result: "error", error: expect.stringContaining("expected 1, got 0") })
        expect(create).not.toHaveBeenCalled()
    })

    it("contract_write on EVM refuses a non-hex payload", async () => {
        const reply = await handleContractWrite(
            { chain: "eth", subchain: "sepolia", is_evm: true, rpc: "", task: { type: "contract_write", params: null, signedPayloads: [{}] } },
            11155111,
        )
        expect(reply).toMatchObject({ result: "error", error: "signed payload is not a hex string" })
    })

    it("pay refuses a missing payload list instead of throwing", async () => {
        const reply = await handlePayOperation(
            { chain: "ton", subchain: "mainnet", is_evm: false, rpc: "", task: { type: "pay", params: null, signedPayloads: undefined } } as never,
            0,
        )
        expect(reply).toMatchObject({ result: "error", error: "signedPayloads is not a list" })
    })
})
