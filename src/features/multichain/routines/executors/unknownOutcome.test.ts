/**
 * A submit that may have reached the target chain but gave no answer is
 * reported as "unknown" with the transaction hash, not as an error: the
 * caller must look the hash up instead of re-sending. Aptos submits have a
 * real deadline, and an XRPL submit no longer waits forever.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
const realConstants = await import("src/utilities/constants")
mock.module("src/utilities/constants", () => ({ ...realConstants, XM_XRPL_SUBMIT_DEADLINE_MS: 30 }))

import {
    Account,
    AccountAddress,
    ChainId,
    EntryFunction,
    RawTransaction,
    SimpleTransaction,
    TransactionPayloadEntryFunction,
    U64,
    generateSignedTransaction,
    generateUserTransactionHash,
} from "@aptos-labs/ts-sdk"
import axios, { AxiosError } from "axios"
import { Wallet } from "xrpl"

const multichain = await import("@kynesyslabs/demosdk/xm-localsdk")
const { aptosSignedTxHash, xrplSignedTxHash } = await import("./signedTxHash")
const { default: handleAptosPayRest } = await import("./aptos_pay_rest")
const { default: handlePayOperation } = await import("./pay")

function signedAptosTx() {
    const sender = Account.generate()
    const payload = new TransactionPayloadEntryFunction(
        EntryFunction.build("0x1::aptos_account", "transfer", [], [AccountAddress.from("0x2"), new U64(1)]),
    )
    const raw = new RawTransaction(sender.accountAddress, 0n, payload, 2000n, 100n, 9_999_999_999n, new ChainId(2))
    const transaction = new SimpleTransaction(raw)
    const senderAuthenticator = sender.signTransactionWithAuthenticator(transaction)
    const bytes = generateSignedTransaction({ transaction, senderAuthenticator })
    return { bytes, hash: generateUserTransactionHash({ transaction, senderAuthenticator }) }
}

function signedXrplTx() {
    const w = Wallet.generate()
    return w.sign({
        TransactionType: "Payment",
        Account: w.address,
        Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        Amount: "1000",
        Fee: "12",
        Sequence: 1,
        Flags: 0,
    } as never)
}

const aptos = signedAptosTx()
const aptosOp = {
    chain: "aptos",
    subchain: "testnet",
    is_evm: false,
    rpc: "",
    task: { type: "pay", params: null, signedPayloads: [Buffer.from(aptos.bytes).toString("hex")] },
}

afterEach(() => jest.restoreAllMocks())

describe("signed transaction hashes", () => {
    it("match the Aptos SDK's user transaction hash", () => {
        expect(aptosSignedTxHash(aptos.bytes)).toBe(aptos.hash)
    })

    it("match the XRPL library's transaction id", () => {
        const signed = signedXrplTx()
        expect(xrplSignedTxHash(signed.tx_blob)).toBe(signed.hash)
    })
})

describe("Aptos submit outcomes", () => {
    it("reports a timeout as unknown with the hash", async () => {
        spyOn(axios, "post").mockRejectedValue(new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED"))
        const reply = await handleAptosPayRest(aptosOp)
        expect(reply).toMatchObject({ result: "unknown", hash: aptos.hash, chain: "aptos.testnet" })
    })

    it("reports a 2xx answer without a hash as unknown, never as success", async () => {
        spyOn(axios, "post").mockResolvedValue({ data: { message: "queued" } } as never)
        const reply = await handleAptosPayRest(aptosOp)
        expect(reply).toMatchObject({ result: "unknown", hash: aptos.hash })
    })

    it("reports an answered refusal and an unreachable node as errors", async () => {
        const refused = new AxiosError("Bad Request", "ERR_BAD_REQUEST", undefined, undefined, {
            status: 400,
            data: { message: "SEQUENCE_NUMBER_TOO_OLD" },
        } as never)
        spyOn(axios, "post").mockRejectedValueOnce(refused).mockRejectedValueOnce(new AxiosError("connect ECONNREFUSED", "ECONNREFUSED"))
        expect(await handleAptosPayRest(aptosOp)).toMatchObject({ result: "error", error: { message: "SEQUENCE_NUMBER_TOO_OLD" } })
        expect(await handleAptosPayRest(aptosOp)).toMatchObject({ result: "error" })
    })

    it.each([500, 502, 503, 504])(
        "reports an HTTP %i answer as unknown with the hash, even with an error body",
        async status => {
            const answered = new AxiosError("Server error", "ERR_BAD_RESPONSE", undefined, undefined, {
                status,
                data: "<html>Bad Gateway</html>",
            } as never)
            spyOn(axios, "post").mockRejectedValue(answered)
            const reply = await handleAptosPayRest(aptosOp)
            expect(reply).toMatchObject({ result: "unknown", hash: aptos.hash, chain: "aptos.testnet" })
            expect(reply.error).toContain(`HTTP ${status}`)
        },
    )

    it("reports a full Aptos mempool (507 mempool_is_full) as an error", async () => {
        const full = new AxiosError("Insufficient Storage", "ERR_BAD_RESPONSE", undefined, undefined, {
            status: 507,
            data: { message: "Mempool is full", error_code: "mempool_is_full" },
        } as never)
        spyOn(axios, "post").mockRejectedValue(full)
        expect(await handleAptosPayRest(aptosOp)).toMatchObject({
            result: "error",
            error: { error_code: "mempool_is_full" },
        })
    })

    it("reports an accepted submit as success with the node's hash", async () => {
        spyOn(axios, "post").mockResolvedValue({ data: { hash: aptos.hash } } as never)
        expect(await handleAptosPayRest(aptosOp)).toEqual({ result: "success", hash: aptos.hash, chain: "aptos.testnet" })
    })
})

describe("XRPL submit deadline", () => {
    function fakeXrpl(submitAndWait: () => Promise<unknown>) {
        const disconnect = jest.fn(async () => undefined)
        spyOn(multichain.XRPL.prototype, "connect").mockImplementation(async function (this: any) {
            this.connected = true
            this.provider = { submitAndWait, disconnect }
            return true
        })
        return disconnect
    }
    const xrplOp = (blob: string): any => ({
        chain: "xrpl",
        subchain: "testnet",
        is_evm: false,
        rpc: "",
        task: { type: "pay", params: null, signedPayloads: [blob] },
    })

    it("reports a submit with no validated result in time as unknown with the hash", async () => {
        const signed = signedXrplTx()
        const disconnect = fakeXrpl(() => new Promise(() => undefined))
        const reply = await handlePayOperation(xrplOp(signed.tx_blob), 0)
        expect(reply).toMatchObject({ result: "unknown", hash: signed.hash })
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it("reports a queued (ter) result as unknown", async () => {
        const signed = signedXrplTx()
        fakeXrpl(async () => ({ result: { meta: { TransactionResult: "terQUEUED" }, hash: signed.hash, validated: false } }))
        expect(await handlePayOperation(xrplOp(signed.tx_blob), 0)).toMatchObject({ result: "unknown", hash: signed.hash })
    })

    it("keeps tesSUCCESS a success and tec an error", async () => {
        const signed = signedXrplTx()
        fakeXrpl(async () => ({ result: { meta: { TransactionResult: "tesSUCCESS" }, hash: signed.hash, validated: true } }))
        expect(await handlePayOperation(xrplOp(signed.tx_blob), 0)).toEqual({ result: "success", hash: signed.hash })
        jest.restoreAllMocks()
        fakeXrpl(async () => ({ result: { meta: { TransactionResult: "tecPATH_DRY" }, hash: signed.hash, validated: true } }))
        expect(await handlePayOperation(xrplOp(signed.tx_blob), 0)).toMatchObject({ result: "error" })
    })

    it("reports a connection lost after the submit as unknown with the hash", async () => {
        const signed = signedXrplTx()
        const disconnect = fakeXrpl(async () => {
            throw new Error("websocket was closed")
        })
        const reply = await handlePayOperation(xrplOp(signed.tx_blob), 0)
        expect(reply).toMatchObject({ result: "unknown", hash: signed.hash })
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it("closes the client when it never connected", async () => {
        const disconnect = jest.fn(async () => undefined)
        spyOn(multichain.XRPL.prototype, "connect").mockImplementation(async function (this: any) {
            this.connected = false
            this.provider = { disconnect }
            return false
        })
        expect(await handlePayOperation(xrplOp(signedXrplTx().tx_blob), 0)).toMatchObject({ result: "error" })
        expect(disconnect).toHaveBeenCalledTimes(1)
    })
})
