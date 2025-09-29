/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* NOTE
    executeTransaction is called BEFORE the transaction is reflected in the GCR, which happens AFTER the
    consensus has confirmed the transaction in the block.
*/

import GCR from "../gcr/gcr"
import Transaction from "../transaction"
import { Operation } from "@kynesyslabs/demosdk/types"
import { PointSystem } from "@/features/incentive/PointSystem"
import log from "@/utilities/logger"

/* NOTE 

Rationale: transactions arrives with a nonce and a timestamp.

The operations contained in a transaction are calculated by executeTransaction, the output is stored
as Operation objects in the GCR.

Each block, the nodes execute the Operation objects ordering them by their timestamp and nonce (see GCR).

*/

async function hasAlreadyReceivedFirstTransactionReward(
    address: string,
): Promise<boolean> {
    try {
        const pointSystem = PointSystem.getInstance()

        const response = await pointSystem.getUserPoints(address)

        if (response.result === 200 && response.response) {
            return response.response.breakdown.firstWalletTransaction > 0
        }

        return false
    } catch (error) {
        return false
    }
}

async function checkAndAwardFirstTransactionRewards(
    sender: string,
    receiver: string,
    txHash: string,
): Promise<void> {
    const pointSystem = PointSystem.getInstance()

    try {
        if (!(await hasAlreadyReceivedFirstTransactionReward(sender))) {
            log.info(
                `[FirstTransactionReward] Awarding points to sender: ${sender} for tx: ${txHash}`,
            )

            try {
                await pointSystem.awardFirstTransactionReward(sender, txHash)
            } catch (error) {
                log.error(
                    `[FirstTransactionReward] Failed to award points to sender ${sender}: ${error}`,
                )
            }
        }

        if (!(await hasAlreadyReceivedFirstTransactionReward(receiver))) {
            log.info(
                `[FirstTransactionReward] Awarding points to receiver: ${receiver} for tx: ${txHash}`,
            )

            try {
                await pointSystem.awardFirstTransactionReward(receiver, txHash)
            } catch (error) {
                log.error(
                    `[FirstTransactionReward] Failed to award points to receiver ${receiver}: ${error}`,
                )
            }
        }
    } catch (error) {
        log.error(
            `[FirstTransactionReward] Error checking first transaction rewards: ${error}`,
        )
    }
}

// INFO Given a transaction, use GCR to see if it is executable and return a result
export default async function executeNativeTransaction(
    transaction: Transaction,
): Promise<[boolean, string, Operation[]?]> {
    let success = true
    let message = ""
    const operations: Operation[] = []

    // ANCHOR Managing simple value transfer
    if (transaction.content.amount > 0) {
        let operation: Operation
        const sender = transaction.content.from.toString("hex")
        const senderBalance = await GCR.getGCRNativeBalance(sender)
        const receiver = transaction.content.to.toString("hex")
        const receiverBalance = await GCR.getGCRNativeBalance(receiver)
        // Refuse transaction if GCR is not in shape
        if (senderBalance < transaction.content.amount) {
            success = false
            message = "Insufficient funds"
            return [success, message]
        }
        // Add value to receiver's balance
        operation = {
            operator: "add_native",
            actor: receiver,
            params: { amount: transaction.content.amount },
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp,
            status: "pending",
            fees: transaction.content.transaction_fee,
        }
        // Adding the operation to the list of operations
        operations.push(operation)
        // Subtract value from sender's balance
        operation = {
            operator: "remove_native",
            actor: sender,
            params: { amount: transaction.content.amount },
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp,
            status: "pending",
            fees: transaction.content.transaction_fee,
        }
        // Adding the operation to the list of operations
        operations.push(operation)
        success = true
        message = "Transaction successful"

        checkAndAwardFirstTransactionRewards(
            sender,
            receiver,
            transaction.hash,
        ).catch(error => {
            log.error(
                `[FirstTransactionReward] Background reward processing failed: ${error}`,
            )
        })

        return [success, message, operations]
    }

    // ANCHOR Managing complex operations
    if (transaction.content.data[0] === "demoswork") {
        // TODO Execute the code based on a currently not defined schema
    }

    return [success, message, operations]
}
