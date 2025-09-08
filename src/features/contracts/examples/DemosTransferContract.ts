/**
 * Example smart contract for native DEM token transfers
 * Demonstrates working with native token balances and transfers
 */

import { DemosContract } from "../execution/ContractBase"

export class DemosTransferContract extends DemosContract {
    /**
     * Transfer native DEM tokens to another address
     * The value is sent with the transaction (this.value)
     */
    public transfer(to: string): boolean {
        this.require(to && to.length > 0, "Invalid recipient address")
        this.require(to !== this.sender, "Cannot transfer to yourself")
        this.require(this.value > 0n, "Transfer amount must be greater than 0")

        // Record the transfer in contract state
        const transferKey = `transfer_${this.blockHeight}_${Date.now()}`
        this.state.set(transferKey, {
            from: this.sender,
            to: to,
            amount: this.value.toString(),
            blockHeight: this.blockHeight,
            timestamp: this.timestamp.toISOString(),
        })

        // Track total volume
        const currentVolume = BigInt(this.state.get("totalVolume") || "0")
        this.state.set("totalVolume", (currentVolume + this.value).toString())

        // Track transfer count
        const transferCount = this.state.get("transferCount") || 0
        this.state.set("transferCount", transferCount + 1)

        // Track sender's total sent
        const senderTotalKey = `senderTotal_${this.sender}`
        const senderTotal = BigInt(this.state.get(senderTotalKey) || "0")
        this.state.set(senderTotalKey, (senderTotal + this.value).toString())

        // Track recipient's total received
        const recipientTotalKey = `recipientTotal_${to}`
        const recipientTotal = BigInt(this.state.get(recipientTotalKey) || "0")
        this.state.set(
            recipientTotalKey,
            (recipientTotal + this.value).toString(),
        )

        this.emit("NativeTransfer", {
            from: this.sender,
            to: to,
            amount: this.value.toString(),
            blockHeight: this.blockHeight,
        })

        return true
    }

    /**
     * Batch transfer to multiple recipients
     * Splits the sent value equally among recipients
     */
    public batchTransfer(recipients: string[]): boolean {
        this.require(recipients.length > 0, "No recipients specified")
        this.require(recipients.length <= 10, "Too many recipients (max 10)")
        this.require(this.value > 0n, "Transfer amount must be greater than 0")

        // Calculate amount per recipient
        const amountPerRecipient = this.value / BigInt(recipients.length)
        this.require(amountPerRecipient > 0n, "Amount too small to split")

        // Validate all recipients
        for (const recipient of recipients) {
            this.require(
                recipient && recipient.length > 0,
                "Invalid recipient address",
            )
            this.require(
                recipient !== this.sender,
                "Cannot transfer to yourself",
            )
        }

        // Record each transfer
        const batchId = `batch_${this.blockHeight}_${Date.now()}`
        this.state.set(batchId, {
            from: this.sender,
            recipients: recipients,
            totalAmount: this.value.toString(),
            amountPerRecipient: amountPerRecipient.toString(),
            recipientCount: recipients.length,
            blockHeight: this.blockHeight,
        })

        // Update totals
        const currentVolume = BigInt(this.state.get("totalVolume") || "0")
        this.state.set("totalVolume", (currentVolume + this.value).toString())

        const transferCount = this.state.get("transferCount") || 0
        this.state.set("transferCount", transferCount + recipients.length)

        // Update sender total
        const senderTotalKey = `senderTotal_${this.sender}`
        const senderTotal = BigInt(this.state.get(senderTotalKey) || "0")
        this.state.set(senderTotalKey, (senderTotal + this.value).toString())

        // Update each recipient total
        for (const recipient of recipients) {
            const recipientTotalKey = `recipientTotal_${recipient}`
            const recipientTotal = BigInt(
                this.state.get(recipientTotalKey) || "0",
            )
            this.state.set(
                recipientTotalKey,
                (recipientTotal + amountPerRecipient).toString(),
            )
        }

        this.emit("BatchTransfer", {
            from: this.sender,
            recipients: recipients,
            totalAmount: this.value.toString(),
            amountPerRecipient: amountPerRecipient.toString(),
            recipientCount: recipients.length,
        })

        return true
    }

    /**
     * Send tips to multiple addresses with custom amounts
     * Total of amounts must equal this.value
     */
    public multiTip(recipients: string[], amounts: string[]): boolean {
        this.require(
            recipients.length === amounts.length,
            "Recipients and amounts length mismatch",
        )
        this.require(recipients.length > 0, "No recipients specified")
        this.require(recipients.length <= 20, "Too many recipients (max 20)")
        this.require(this.value > 0n, "Transfer amount must be greater than 0")

        // Validate recipients and calculate total
        let totalAmount = 0n
        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i]
            const amount = BigInt(amounts[i])

            this.require(
                recipient && recipient.length > 0,
                "Invalid recipient address",
            )
            this.require(
                recipient !== this.sender,
                "Cannot transfer to yourself",
            )
            this.require(amount > 0n, "All amounts must be positive")

            totalAmount += amount
        }

        // Ensure total matches sent value
        this.require(
            totalAmount === this.value,
            "Total tip amounts must equal sent value",
        )

        // Record the multi-tip
        const tipId = `multitip_${this.blockHeight}_${Date.now()}`
        this.state.set(tipId, {
            from: this.sender,
            recipients: recipients,
            amounts: amounts,
            totalAmount: totalAmount.toString(),
            blockHeight: this.blockHeight,
        })

        // Update totals
        const currentVolume = BigInt(this.state.get("totalVolume") || "0")
        this.state.set("totalVolume", (currentVolume + totalAmount).toString())

        const transferCount = this.state.get("transferCount") || 0
        this.state.set("transferCount", transferCount + recipients.length)

        // Update sender total
        const senderTotalKey = `senderTotal_${this.sender}`
        const senderTotal = BigInt(this.state.get(senderTotalKey) || "0")
        this.state.set(senderTotalKey, (senderTotal + totalAmount).toString())

        // Update each recipient total
        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i]
            const amount = BigInt(amounts[i])

            const recipientTotalKey = `recipientTotal_${recipient}`
            const recipientTotal = BigInt(
                this.state.get(recipientTotalKey) || "0",
            )
            this.state.set(
                recipientTotalKey,
                (recipientTotal + amount).toString(),
            )
        }

        this.emit("MultiTip", {
            from: this.sender,
            recipients: recipients,
            amounts: amounts,
            totalAmount: totalAmount.toString(),
            recipientCount: recipients.length,
        })

        return true
    }

    /**
     * Get transfer statistics
     */
    public getStats(): object {
        return {
            totalVolume: this.state.get("totalVolume") || "0",
            transferCount: this.state.get("transferCount") || 0,
            contractAddress: this.address,
            blockHeight: this.blockHeight,
        }
    }

    /**
     * Get address statistics
     */
    public getAddressStats(address: string): object {
        this.require(address && address.length > 0, "Invalid address")

        const senderTotalKey = `senderTotal_${address}`
        const recipientTotalKey = `recipientTotal_${address}`

        return {
            address: address,
            totalSent: this.state.get(senderTotalKey) || "0",
            totalReceived: this.state.get(recipientTotalKey) || "0",
        }
    }

    /**
     * Get recent transfers (last 10)
     */
    public getRecentTransfers(): object[] {
        const transfers: object[] = []
        const allKeys = this.state.keys()

        // Find transfer keys and sort by block height (simplified)
        const transferKeys = allKeys
            .filter(
                key =>
                    key.startsWith("transfer_") ||
                    key.startsWith("batch_") ||
                    key.startsWith("multitip_"),
            )
            .slice(-10) // Get last 10

        for (const key of transferKeys) {
            const transfer = this.state.get(key)
            if (transfer) {
                transfers.push({
                    id: key,
                    ...transfer,
                })
            }
        }

        return transfers
    }

    /**
     * Emergency function to get contract info
     */
    public getContractInfo(): object {
        return {
            name: "DemosTransferContract",
            version: "1.0.0",
            description: "Native DEM token transfer utility",
            address: this.address,
            blockHeight: this.blockHeight,
            timestamp: this.timestamp,
            currentSender: this.sender,
            valueReceived: this.value.toString(),
        }
    }
}
