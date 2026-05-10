import Datasource from "src/model/datasource"
import { Transactions } from "src/model/entities/Transactions"
import log from "src/utilities/logger"

import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import Block from "../block"
import Chain from "../chain"
import GCR from "../gcr/gcr"
import Genesis from "../types/genesisTypes"
// NOTE Due to the modularity of the code, many routines will be stored in their own modules
// TODO Move everything there if possible
import gcrRoutines from "../gcr/gcr_routines"

// REVIEW Is this working?
export default class SubOperations {
    public static gcrRoutines = gcrRoutines

    private static result: OperationResult = {
        success: true,
        message: "No error occurred",
    }
    constructor() {}

    // INFO Compiling the genesis status if not already done
    static async genesis(
        operation: Operation,
        genesisBlock: Block,
    ): Promise<OperationResult> {
        const result: OperationResult = {
            success: true,
            message: "No error occurred",
        }
        // NOTE Insert blindly stuff into the GCR if no genesis is present
        // Using the genesis schema it is easy to follow the structure of the genesis file
        log.debug(
            "Genesis operation params: " + JSON.stringify(operation.params),
        )
        const genesisContent: Genesis = operation.params
        // Let's extract the genesis transaction from the genesis block
        const genesisTx = await Chain.getTransactionFromHash(
            genesisBlock.content.ordered_transactions[0],
        )
        // NOTE Writing the tx to the chain tx table as it is the genesis one
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)

        // Assuming genesis_tx.content is an object that needs to be serialized as JSON
        const transaction = new Transactions()
        transaction.hash = genesisTx.hash
        transaction.content = genesisTx.content
        transaction.signature = "genesis"
        transaction.status = genesisTx.status ?? "confirmed"
        transaction.type = "genesis"
        transaction.blockNumber = 0
        transaction.from = genesisTx.content.from ?? "0x0"
        transaction.from_ed25519_address =
            genesisTx.content.from_ed25519_address ?? "0x0"
        transaction.to = genesisTx.content.to ?? "0x0"
        // REVIEW P-1 widened the entity to `bigint`; use a bigint literal
        // so the assignment matches the column type.
        transaction.amount = 0n // TODO: Maybe store the amount as defined in balances below here?
        transaction.nonce = 0
        transaction.timestamp = genesisTx.content.timestamp ?? Date.now()
        transaction.ed25519_signature = genesisTx.ed25519_signature
        // REVIEW Fee columns are now `bigint`; SDK still serialises fees as
        // `number` on the wire, so coerce at the entity boundary.
        transaction.networkFee = BigInt(
            genesisTx.content.transaction_fee?.network_fee ?? 0,
        )
        transaction.rpcFee = BigInt(
            genesisTx.content.transaction_fee?.rpc_fee ?? 0,
        )
        transaction.additionalFee = BigInt(
            genesisTx.content.transaction_fee?.additional_fee ?? 0,
        )

        // Save the new transaction
        await transactionRepository.save(transaction)

        // NOTE Balances
        const balances = genesisContent.balances
        for (let i = 0; i < balances.length; i++) {
            const balanceOperation = balances[i]
            const receiver = balanceOperation[0]
            const amount = balanceOperation[1]
            // REVIEW Use BigInt to avoid silent truncation on amounts > 2^53
            // that parseInt() would otherwise hide.
            // myc#78 / GH#3213223279: capture the boolean return and
            // throw on `false`. Genesis is consensus-relevant: a partial
            // load means this node's legacy GCR diverges from peers as
            // soon as block 1 references one of the missing balances.
            // Refusing to start is strictly safer than booting with a
            // silently-corrupt ledger (locked decision Q1: do not widen
            // the legacy JSONB cap; surface the failure instead).
            const ok = await GCR.setGCRNativeBalance(
                receiver,
                BigInt(amount),
                operation.hash,
            )
            if (!ok) {
                throw new Error(
                    `Genesis balance load failed for receiver ${receiver}: setGCRNativeBalance returned false. Genesis is consensus-relevant; partial loads are forbidden.`,
                )
            }
        }
        return result
    }

    // INFO Remove & Add transfer operation for native balances
    static async transferNative(
        operation: Operation,
    ): Promise<OperationResult> {
        const from: string = operation.params.from
        const to: string = operation.params.to
        // REVIEW Use BigInt to avoid silent truncation on amounts > 2^53.
        // BigInt() throws on invalid input (instead of returning NaN like
        // parseInt did), so we wrap and translate the failure to the same
        // OperationResult shape the caller already handled.
        let amount: bigint
        try {
            amount = BigInt(operation.params.amount)
        } catch {
            return {
                success: false,
                message: "Invalid amount",
            }
        }
        const balanceFrom = await GCR.getGCRNativeBalance(from)
        const balanceTo = await GCR.getGCRNativeBalance(to)
        // Sanity checks

        if (amount === 0n) {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        } else if (amount > balanceFrom) {
            return {
                success: false,
                message: "Insufficient funds",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        const newBalanceFrom = balanceFrom - amount
        const newBalanceTo = balanceTo + amount
        await GCR.setGCRNativeBalance(from, newBalanceFrom, operation.hash)
        await GCR.setGCRNativeBalance(to, newBalanceTo, operation.hash)
        // Returning success
        return {
            success: true,
            message: "Transfer successful",
        }
    }

    // INFO Adding native tokens to the stated address
    static async addNative(operation: Operation): Promise<OperationResult> {
        const to: string = operation.params.to
        const amount: string = operation.params.amount
        const balanceTo = await GCR.getGCRNativeBalance(to)
        // Sanity checks
        if (amount === "0") {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        // REVIEW BigInt() to avoid silent truncation on amounts > 2^53.
        let parsedAmount: bigint
        try {
            parsedAmount = BigInt(amount)
        } catch {
            return {
                success: false,
                message: "Invalid amount",
            }
        }
        const newBalanceTo = balanceTo + parsedAmount
        await GCR.setGCRNativeBalance(to, newBalanceTo, operation.hash)
        return SubOperations.result
    }

    // INFO Removing native tokens from the stated address
    static async removeNative(operation: Operation): Promise<OperationResult> {
        const to: string = operation.params.to
        const amount: string = operation.params.amount
        const balanceTo = await GCR.getGCRNativeBalance(to)
        // Sanity checks
        if (amount === "0") {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        }
        // REVIEW BigInt() to avoid silent truncation on amounts > 2^53.
        let parsedAmount: bigint
        try {
            parsedAmount = BigInt(amount)
        } catch {
            return {
                success: false,
                message: "Invalid amount",
            }
        }
        if (balanceTo < parsedAmount) {
            return {
                success: false,
                message: "Insufficient funds",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        const newBalanceTo = balanceTo - parsedAmount
        await GCR.setGCRNativeBalance(to, newBalanceTo, operation.hash)
        return SubOperations.result
    }

    static async addAsset(operation: Operation): Promise<OperationResult> {
        // TODO
        return SubOperations.result
    }

    static async removeAsset(operation: Operation): Promise<OperationResult> {
        // TODO
        return SubOperations.result
    }
}
