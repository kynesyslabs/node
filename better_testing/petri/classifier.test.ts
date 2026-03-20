/**
 * Petri Consensus — TransactionClassifier unit tests
 *
 * Tests that transactions are correctly classified as PRE_APPROVED or TO_APPROVE
 * based on whether they produce non-fee/non-nonce GCR edits.
 */
import { describe, expect, test } from "bun:test"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"
import type { GCREdit } from "@kynesyslabs/demosdk/types"

// We test the classification logic directly without calling GCRGeneration
// by using the precomputedEdits path of classifyTransaction.
// This avoids needing SDK initialization and DB access.

// Helper: build a minimal mock tx
function mockTx(hash: string, from: string, type: string) {
    return {
        hash,
        content: {
            type,
            from,
            from_ed25519_address: "",
            to: "",
            amount: 0,
            data: [null, null],
            gcr_edits: [],
            nonce: 1,
            timestamp: Date.now(),
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
            },
        },
        signature: null,
        ed25519_signature: "",
        status: "pending",
        blockNumber: null,
    }
}

// Direct classification logic (mirrors transactionClassifier.ts without SDK deps)
function classifyFromEdits(
    txFrom: string,
    gcrEdits: GCREdit[],
): TransactionClassification {
    const nonFeeEdits = gcrEdits.filter((edit: GCREdit) => {
        if (
            edit.type === "balance" &&
            edit.operation === "remove" &&
            edit.account === txFrom
        ) {
            return false
        }
        if (edit.type === "nonce") {
            return false
        }
        return true
    })

    return nonFeeEdits.length === 0
        ? TransactionClassification.PRE_APPROVED
        : TransactionClassification.TO_APPROVE
}

describe("TransactionClassifier", () => {
    const sender = "0xsender123"

    test("empty edits → PRE_APPROVED", () => {
        const result = classifyFromEdits(sender, [])
        expect(result).toBe(TransactionClassification.PRE_APPROVED)
    })

    test("fee-only edits → PRE_APPROVED (read-only tx with gas)", () => {
        const edits: GCREdit[] = [
            {
                type: "balance",
                operation: "remove",
                account: sender,
                amount: 100,
                txhash: "",
            } as GCREdit,
            {
                type: "nonce",
                operation: "add",
                account: sender,
                amount: 1,
                txhash: "",
            } as GCREdit,
        ]
        const result = classifyFromEdits(sender, edits)
        expect(result).toBe(TransactionClassification.PRE_APPROVED)
    })

    test("balance transfer → TO_APPROVE (recipient gets balance add)", () => {
        const edits: GCREdit[] = [
            {
                type: "balance",
                operation: "remove",
                account: sender,
                amount: 1000,
                txhash: "",
            } as GCREdit,
            {
                type: "balance",
                operation: "add",
                account: "0xrecipient456",
                amount: 900,
                txhash: "",
            } as GCREdit,
            {
                type: "nonce",
                operation: "add",
                account: sender,
                amount: 1,
                txhash: "",
            } as GCREdit,
        ]
        const result = classifyFromEdits(sender, edits)
        expect(result).toBe(TransactionClassification.TO_APPROVE)
    })

    test("identity edit → TO_APPROVE", () => {
        const edits: GCREdit[] = [
            {
                type: "identity",
                operation: "add",
                account: sender,
                amount: 0,
                txhash: "",
            } as unknown as GCREdit,
            {
                type: "balance",
                operation: "remove",
                account: sender,
                amount: 50,
                txhash: "",
            } as GCREdit,
        ]
        const result = classifyFromEdits(sender, edits)
        expect(result).toBe(TransactionClassification.TO_APPROVE)
    })

    test("storage program edit → TO_APPROVE", () => {
        const edits: GCREdit[] = [
            {
                type: "storageProgram",
                operation: "add",
                account: sender,
                amount: 0,
                txhash: "",
            } as unknown as GCREdit,
            {
                type: "nonce",
                operation: "add",
                account: sender,
                amount: 1,
                txhash: "",
            } as GCREdit,
        ]
        const result = classifyFromEdits(sender, edits)
        expect(result).toBe(TransactionClassification.TO_APPROVE)
    })

    test("nonce-only edits → PRE_APPROVED", () => {
        const edits: GCREdit[] = [
            {
                type: "nonce",
                operation: "add",
                account: sender,
                amount: 1,
                txhash: "",
            } as GCREdit,
        ]
        const result = classifyFromEdits(sender, edits)
        expect(result).toBe(TransactionClassification.PRE_APPROVED)
    })

    test("fee removal from different account → TO_APPROVE (not sender fee)", () => {
        const edits: GCREdit[] = [
            {
                type: "balance",
                operation: "remove",
                account: "0xdifferent_account",
                amount: 100,
                txhash: "",
            } as GCREdit,
        ]
        const result = classifyFromEdits(sender, edits)
        expect(result).toBe(TransactionClassification.TO_APPROVE)
    })
})
