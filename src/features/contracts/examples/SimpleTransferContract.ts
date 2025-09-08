/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Example smart contract demonstrating DemosContract usage
 * Simple token transfer contract with balances and allowances
 */

import { DemosContract } from "../execution/ContractBase"

export class SimpleTransferContract extends DemosContract {
    /**
     * Initialize contract with initial supply
     */
    constructor() {
        super()
        // Constructor logic will be called after __initialize
    }

    /**
     * Initialize the contract with token supply
     * This would be called during deployment
     */
    public initialize(
        initialSupply: number,
        tokenName: string,
        tokenSymbol: string,
    ): void {
        // Only allow initialization once
        this.require(
            !this.state.has("initialized"),
            "Contract already initialized",
        )

        // Set token metadata
        this.state.set("name", tokenName)
        this.state.set("symbol", tokenSymbol)
        this.state.set("totalSupply", initialSupply)
        this.state.set("initialized", true)

        // Give initial supply to contract creator
        const creatorBalance = `balance_${this.sender}`
        this.state.set(creatorBalance, initialSupply)

        this.emit("Transfer", {
            from: "0x0",
            to: this.sender,
            amount: initialSupply,
        })

        this.emit("ContractInitialized", {
            name: tokenName,
            symbol: tokenSymbol,
            totalSupply: initialSupply,
            creator: this.sender,
        })
    }

    /**
     * Get token balance for an address
     */
    public balanceOf(address: string): number {
        this.require(address && address.length > 0, "Invalid address")
        return this.state.get(`balance_${address}`) || 0
    }

    /**
     * Transfer tokens to another address
     */
    public transfer(to: string, amount: number): boolean {
        return this._transfer(this.sender, to, amount)
    }

    /**
     * Transfer tokens from one address to another (requires allowance)
     */
    public transferFrom(from: string, to: string, amount: number): boolean {
        // Check allowance
        const allowanceKey = `allowance_${from}_${this.sender}`
        const allowance = this.state.get(allowanceKey) || 0

        this.require(allowance >= amount, "Transfer amount exceeds allowance")

        // Perform transfer
        const success = this._transfer(from, to, amount)

        if (success) {
            // Reduce allowance
            this.state.set(allowanceKey, allowance - amount)

            this.emit("Approval", {
                owner: from,
                spender: this.sender,
                amount: allowance - amount,
            })
        }

        return success
    }

    /**
     * Approve another address to spend tokens on your behalf
     */
    public approve(spender: string, amount: number): boolean {
        this.require(spender && spender.length > 0, "Invalid spender address")
        this.require(amount >= 0, "Approval amount must be non-negative")

        const allowanceKey = `allowance_${this.sender}_${spender}`
        this.state.set(allowanceKey, amount)

        this.emit("Approval", {
            owner: this.sender,
            spender,
            amount,
        })

        return true
    }

    /**
     * Get allowance for a spender
     */
    public allowance(owner: string, spender: string): number {
        this.require(owner && owner.length > 0, "Invalid owner address")
        this.require(spender && spender.length > 0, "Invalid spender address")

        const allowanceKey = `allowance_${owner}_${spender}`
        return this.state.get(allowanceKey) || 0
    }

    /**
     * Mint new tokens (only by contract creator)
     */
    public mint(to: string, amount: number): boolean {
        // Get the original creator
        const creator = this._getCreator()
        this.requireSender(creator, "Only contract creator can mint tokens")

        this.require(to && to.length > 0, "Invalid recipient address")
        this.require(amount > 0, "Mint amount must be positive")

        // Update total supply
        const currentSupply = this.state.get("totalSupply") || 0
        this.state.set("totalSupply", currentSupply + amount)

        // Update recipient balance
        const balanceKey = `balance_${to}`
        const currentBalance = this.state.get(balanceKey) || 0
        this.state.set(balanceKey, currentBalance + amount)

        this.emit("Transfer", {
            from: "0x0",
            to,
            amount,
        })

        this.emit("Mint", {
            to,
            amount,
            newTotalSupply: currentSupply + amount,
        })

        return true
    }

    /**
     * Burn tokens from sender's balance
     */
    public burn(amount: number): boolean {
        this.require(amount > 0, "Burn amount must be positive")

        const balanceKey = `balance_${this.sender}`
        const currentBalance = this.state.get(balanceKey) || 0

        this.require(currentBalance >= amount, "Burn amount exceeds balance")

        // Update balance
        this.state.set(balanceKey, currentBalance - amount)

        // Update total supply
        const currentSupply = this.state.get("totalSupply") || 0
        this.state.set("totalSupply", currentSupply - amount)

        this.emit("Transfer", {
            from: this.sender,
            to: "0x0",
            amount,
        })

        this.emit("Burn", {
            from: this.sender,
            amount,
            newTotalSupply: currentSupply - amount,
        })

        return true
    }

    /**
     * Get token information
     */
    public getTokenInfo(): object {
        return {
            name: this.state.get("name") || "Unknown Token",
            symbol: this.state.get("symbol") || "UNK",
            totalSupply: this.state.get("totalSupply") || 0,
            contractAddress: this.address,
            initialized: this.state.get("initialized") || false,
        }
    }

    /**
     * Get contract creator (first person to call initialize)
     */
    private _getCreator(): string {
        // Find the first Transfer event from 0x0 to get the creator
        const events = this.__getEvents()
        for (const event of events) {
            if (event.name === "Transfer" && event.args.from === "0x0") {
                return event.args.to
            }
        }

        // Fallback: check state
        return this.state.get("creator") || this.sender
    }

    /**
     * Internal transfer function
     */
    private _transfer(from: string, to: string, amount: number): boolean {
        this.require(from && from.length > 0, "Invalid sender address")
        this.require(to && to.length > 0, "Invalid recipient address")
        this.require(amount > 0, "Transfer amount must be positive")
        this.require(from !== to, "Cannot transfer to yourself")

        // Check sender balance
        const fromBalanceKey = `balance_${from}`
        const fromBalance = this.state.get(fromBalanceKey) || 0

        this.require(fromBalance >= amount, "Transfer amount exceeds balance")

        // Update balances
        const toBalanceKey = `balance_${to}`
        const toBalance = this.state.get(toBalanceKey) || 0

        this.state.set(fromBalanceKey, fromBalance - amount)
        this.state.set(toBalanceKey, toBalance + amount)

        this.emit("Transfer", {
            from,
            to,
            amount,
            fromBalance: fromBalance - amount,
            toBalance: toBalance + amount,
        })

        return true
    }

    /**
     * Batch transfer to multiple recipients
     */
    public batchTransfer(recipients: string[], amounts: number[]): boolean {
        this.require(
            recipients.length === amounts.length,
            "Recipients and amounts length mismatch",
        )
        this.require(recipients.length > 0, "No recipients specified")
        this.require(recipients.length <= 100, "Too many recipients (max 100)")

        // Calculate total amount needed
        let totalAmount = 0
        for (const amount of amounts) {
            this.require(amount > 0, "All amounts must be positive")
            totalAmount += amount
        }

        // Check sender has enough balance
        const senderBalance = this.balanceOf(this.sender)
        this.require(
            senderBalance >= totalAmount,
            "Insufficient balance for batch transfer",
        )

        // Perform all transfers
        for (let i = 0; i < recipients.length; i++) {
            this._transfer(this.sender, recipients[i], amounts[i])
        }

        this.emit("BatchTransfer", {
            from: this.sender,
            recipientCount: recipients.length,
            totalAmount,
        })

        return true
    }
}
