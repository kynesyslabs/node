// REVIEW: GCRTokenRoutines - Handler for token GCREdit operations
// REVIEW: Phase 5.1 - Integrated with HookExecutor for script execution in consensus
import { EntityManager, Repository } from "typeorm"

import { GCRToken } from "@/model/entities/GCRv2/GCR_Token"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import ensureGCRForUser from "./ensureGCRForUser"
import Datasource from "@/model/datasource"
import log from "@/utilities/logger"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { getSharedState } from "@/utilities/sharedState"

// Scripting system imports for hook execution
import {
    HookExecutor,
    scriptExecutor,
    applyMutations,
    createTransferMutations,
    createMintMutations,
    createBurnMutations,
    type TokenMutation,
    type ExecuteWithHooksRequest,
    type HookExecutionResult,
    type GCRTokenData,
} from "@/libs/scripting"

// SDK Transaction type for context
import type { Transaction } from "@kynesyslabs/demosdk/types"

import { GCRResult } from "../handleGCR"
import {
    GCREditToken,
    GCREditTokenCreate,
    GCREditTokenTransfer,
    GCREditTokenMint,
    GCREditTokenBurn,
    GCREditTokenPause,
    GCREditTokenUnpause,
    GCREditTokenUpdateACL,
    GCREditTokenGrantPermission,
    GCREditTokenRevokePermission,
    GCREditTokenUpgradeScript,
    GCREditTokenTransferOwnership,
    GCREditTokenCustom,
} from "../types/token/GCREditToken"
import type { TokenPermission, TokenHolderReference } from "../types/token/TokenTypes"
import { hasPermission } from "../types/token/TokenTypes"
import { Referrals } from "@/features/incentive/referrals"

/**
 * GCRTokenRoutines handles all token-related GCR edit operations.
 *
 * Implements:
 * - handleCreateToken: Initialize token GCR entry with metadata, balances, ACL
 * - handleTransferToken: Update balances in token GCR, update holder pointers (with hooks)
 * - handleMintToken: Increase supply and balance (check permissions, with hooks)
 * - handleBurnToken: Decrease supply and balance (check permissions, with hooks)
 * - handleUpdateTokenACL: Modify ACL entries
 * - handlePauseToken / handleUnpauseToken: Toggle paused state
 * - handleUpgradeTokenScript: Replace script code (check permissions)
 * - handleTransferOwnership: Transfer token ownership
 *
 * REVIEW: Phase 5.1 - Script execution integrated via HookExecutor for transfer, mint, burn
 */
export default class GCRTokenRoutines {
    // REVIEW: Phase 5.1 - HookExecutor instance for script execution in consensus
    private static hookExecutor: HookExecutor | null = null

    /**
     * Get or create the HookExecutor instance
     */
    private static getHookExecutor(): HookExecutor {
        if (!this.hookExecutor) {
            this.hookExecutor = new HookExecutor(scriptExecutor)
        }
        return this.hookExecutor
    }

    private static buildEmptyHolderAccount(pubkey: string): GCRMain {
        const account = new GCRMain()
        account.pubkey = pubkey
        account.balance = 0n
        account.identities = {
            xm: {},
            web2: {},
            pqc: {},
            ud: [],
        }
        account.assignedTxs = []
        account.nonce = 0
        account.extended = {
            tokens: [],
            nfts: [],
            xm: [],
            web2: [],
            other: [],
        }
        account.points = {
            totalPoints: 0,
            breakdown: {
                web3Wallets: {},
                socialAccounts: {
                    twitter: 0,
                    github: 0,
                    discord: 0,
                    telegram: 0,
                },
                referrals: 0,
                demosFollow: 0,
                nomisScores: {},
            },
            lastUpdated: new Date(),
        }
        account.referralInfo = {
            totalReferrals: 0,
            referralCode: Referrals.generateReferralCode(pubkey),
            referrals: [],
            referredBy: null,
        }
        account.flagged = false
        account.flaggedReason = ""
        account.reviewed = false
        account.createdAt = new Date()
        account.updatedAt = new Date()
        return account
    }

    /**
     * Convert GCRToken entity to GCRTokenData for hook execution
     * REVIEW: Phase 5.1 - Required for HookExecutor integration
     */
    private static tokenToGCRTokenData(token: GCRToken): GCRTokenData {
        return {
            address: token.address,
            name: token.name,
            ticker: token.ticker,
            decimals: token.decimals,
            owner: token.owner,
            totalSupply: BigInt(token.totalSupply),
            balances: Object.fromEntries(
                Object.entries(token.balances).map(([k, v]) => [k, BigInt(v)]),
            ),
            allowances: Object.fromEntries(
                Object.entries(token.allowances).map(([owner, spenders]) => [
                    owner,
                    Object.fromEntries(
                        Object.entries(spenders).map(([spender, v]) => [spender, BigInt(v)]),
                    ),
                ]),
            ),
            paused: token.paused,
            storage: token.customState,
        }
    }

    /**
     * Apply GCRTokenData mutations back to GCRToken entity
     * REVIEW: Phase 5.1 - Required for HookExecutor integration
     */
    private static applyGCRTokenDataToEntity(token: GCRToken, data: GCRTokenData): void {
        token.totalSupply = data.totalSupply.toString()
        token.balances = Object.fromEntries(
            Object.entries(data.balances).map(([k, v]) => [k, v.toString()]),
        )
        token.allowances = Object.fromEntries(
            Object.entries(data.allowances).map(([owner, spenders]) => [
                owner,
                Object.fromEntries(
                    Object.entries(spenders).map(([spender, v]) => [spender, v.toString()]),
                ),
            ]),
        )
        if (data.storage !== undefined) {
            token.customState = data.storage
        }
    }

    private static getDeterministicTxTimestamp(tx?: Transaction): number {
        const raw = (tx as any)?.content?.timestamp
        const value =
            typeof raw === "number"
                ? raw
                : typeof raw === "string"
                  ? Number.parseInt(raw, 10)
                  : Number.NaN
        if (!Number.isFinite(value)) {
            throw new Error("Missing deterministic tx.content.timestamp")
        }
        return value
    }

    private static getDeterministicPrevBlockHash(): string {
        const sharedState = getSharedState
        return sharedState.lastBlockHash ?? "0".repeat(64)
    }

    private static getDeterministicBlockHeight(tx?: Transaction): number {
        const fromTx = (tx as any)?.blockNumber
        if (typeof fromTx === "number" && Number.isFinite(fromTx) && fromTx >= 0) return fromTx
        const sharedState = getSharedState
        const fromShared = sharedState.lastBlockNumber
        if (typeof fromShared === "number" && Number.isFinite(fromShared) && fromShared >= 0) return fromShared
        return 0
    }

    private static buildHookTxContext(tx: Transaction) {
        return {
            caller: tx.content.from,
            txHash: tx.hash,
            timestamp: this.getDeterministicTxTimestamp(tx),
            blockHeight: this.getDeterministicBlockHeight(tx),
            prevBlockHash: this.getDeterministicPrevBlockHash(),
        }
    }

    /**
     * Main entry point for applying token GCREdit operations
     * REVIEW: Phase 5.1 - Now accepts optional Transaction for script execution context
     */
    static async apply(
        editOperation: GCREditToken,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction, // REVIEW: Phase 5.1 - Transaction context for hook execution
    ): Promise<GCRResult> {
        if (editOperation.type !== "token") {
            return { success: false, message: "Invalid GCREdit type for token routine" }
        }

        if (tx) {
            const txFrom =
                typeof tx.content?.from !== "string"
                    ? forgeToHex(tx.content?.from as any)
                    : tx.content.from
            const editAccount =
                typeof editOperation.account !== "string"
                    ? forgeToHex(editOperation.account as any)
                    : editOperation.account
            if (
                typeof txFrom === "string" &&
                typeof editAccount === "string" &&
                txFrom.toLowerCase() !== editAccount.toLowerCase()
            ) {
                return {
                    success: false,
                    message: "Token edit caller mismatch (edit.account must match tx.content.from)",
                }
            }
        }

        // Normalize account address
        const normalizedAccount =
            typeof editOperation.account !== "string"
                ? forgeToHex(editOperation.account as any)
                : editOperation.account

        const rollbackStr = editOperation.isRollback ? "ROLLBACK" : "NORMAL"
        log.debug(
            "[GCRTokenRoutines] Applying token operation: " +
                editOperation.operation +
                " (" +
                rollbackStr +
                ")",
        )

        // Clone and potentially reverse for rollback
        const edit = { ...editOperation, account: normalizedAccount }

        // Route to appropriate handler
        // REVIEW: Phase 5.1 - Pass tx to handlers that support hooks (transfer, mint, burn)
        switch (edit.operation) {
            case "create":
                return this.handleCreateToken(
                    edit as GCREditTokenCreate,
                    gcrTokenRepository,
                    simulate,
                )
            case "transfer":
                return this.handleTransferToken(
                    edit as GCREditTokenTransfer,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "mint":
                return this.handleMintToken(
                    edit as GCREditTokenMint,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "burn":
                return this.handleBurnToken(
                    edit as GCREditTokenBurn,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "pause":
                return this.handlePauseToken(
                    edit as GCREditTokenPause,
                    gcrTokenRepository,
                    simulate,
                )
            case "unpause":
                return this.handleUnpauseToken(
                    edit as GCREditTokenUnpause,
                    gcrTokenRepository,
                    simulate,
                )
            case "updateACL":
                return this.handleUpdateTokenACL(
                    edit as GCREditTokenUpdateACL,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "grantPermission":
                return this.handleGrantPermission(
                    edit as GCREditTokenGrantPermission,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "revokePermission":
                return this.handleRevokePermission(
                    edit as GCREditTokenRevokePermission,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "upgradeScript":
                return this.handleUpgradeTokenScript(
                    edit as GCREditTokenUpgradeScript,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            case "transferOwnership":
                return this.handleTransferOwnership(
                    edit as GCREditTokenTransferOwnership,
                    gcrTokenRepository,
                    simulate,
                )
            // REVIEW: Phase 5.2 - Custom script method execution
            case "custom":
                return this.handleCustomMethod(
                    edit as GCREditTokenCustom,
                    gcrTokenRepository,
                    simulate,
                    tx,
                )
            default:
                return {
                    success: false,
                    message: "Unknown token operation: " + (edit as any).operation,
                }
        }
    }

    /**
     * Handle token creation - initializes a new token GCR entry
     */
    private static async handleCreateToken(
        edit: GCREditTokenCreate,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { tokenData } = edit.data
        const tokenAddress = edit.data.tokenAddress

        log.debug("[GCRTokenRoutines] Creating token: " + tokenAddress)

        // For rollback, delete the token
        if (edit.isRollback) {
            if (!simulate) {
                await gcrTokenRepository.delete({ address: tokenAddress })
                // Remove holder reference for deployer
                await this.removeHolderReference(
                    tokenData.metadata.deployer,
                    tokenAddress,
                )
                log.info("[GCRTokenRoutines] Rolled back token creation: " + tokenAddress)
            }
            return { success: true, message: "Token creation rolled back" }
        }

        // Check if token already exists
        const existing = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (existing) {
            return {
                success: false,
                message: "Token already exists at address: " + tokenAddress,
            }
        }

        // Create new token entity
        const token = new GCRToken()
        token.address = tokenAddress
        token.name = tokenData.metadata.name
        token.ticker = tokenData.metadata.ticker
        token.decimals = tokenData.metadata.decimals
        token.deployer = tokenData.metadata.deployer
        token.deployerNonce = tokenData.metadata.deployerNonce
        token.deployedAt = tokenData.metadata.deployedAt
        token.hasScript = tokenData.metadata.hasScript
        token.totalSupply = tokenData.state.totalSupply
        token.balances = tokenData.state.balances
        token.allowances = tokenData.state.allowances
        token.customState = tokenData.state.customState
        token.owner = tokenData.accessControl.owner
        token.paused = tokenData.accessControl.paused
        token.aclEntries = tokenData.accessControl.entries
        token.script = tokenData.script
        token.deployTxHash = edit.txhash

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)

                // Add holder reference for deployer if they have balance
                const deployerBalance = tokenData.state.balances[tokenData.metadata.deployer] ?? "0"
                if (BigInt(deployerBalance) > 0n) {
                    await this.addHolderReference(tokenData.metadata.deployer, {
                        tokenAddress,
                        ticker: tokenData.metadata.ticker,
                        name: tokenData.metadata.name,
                        decimals: tokenData.metadata.decimals,
                    })
                }

                log.info(
                    "[GCRTokenRoutines] Created token " +
                        tokenData.metadata.ticker +
                        " at " +
                        tokenAddress,
                )
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to create token: " + error)
                return { success: false, message: "Failed to save token" }
            }
        }

        return { success: true, message: "Token created successfully" }
    }

    /**
     * Handle token transfer - updates balances and holder pointers
     */
    private static async handleTransferToken(
        edit: GCREditTokenTransfer,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction, // REVIEW: Phase 5.1 - Transaction context for hook execution
    ): Promise<GCRResult> {
        const { from, to, amount } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Transfer: " +
                amount +
                " from " +
                from +
                " to " +
                to +
                " for token " +
                tokenAddress,
        )

        const transferAmount = BigInt(amount)
        if (transferAmount <= 0n) {
            return { success: false, message: "Transfer amount must be positive" }
        }

        // For rollback, reverse the direction
        const actualFrom = edit.isRollback ? to : from
        const actualTo = edit.isRollback ? from : to
        const isSelfTransfer =
            typeof actualFrom === "string" &&
            typeof actualTo === "string" &&
            actualFrom.toLowerCase() === actualTo.toLowerCase()

        // In simulate mode we must avoid persisting, so a simple read/compute is fine.
        if (simulate) {
            const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
            if (!token) return { success: false, message: "Token not found: " + tokenAddress }
            if (token.paused && !edit.isRollback) return { success: false, message: "Token is paused" }

            const fromBalance = BigInt(token.balances[actualFrom] ?? "0")
            if (fromBalance < transferAmount) return { success: false, message: "Insufficient balance" }

            const prevToBalance = BigInt(token.balances[actualTo] ?? "0")

            if (token.hasScript && token.script?.code && tx && !edit.isRollback) {
                try {
                    const hookExecutor = this.getHookExecutor()
                    const tokenData = this.tokenToGCRTokenData(token)
                    const nativeMutations = isSelfTransfer
                        ? []
                        : createTransferMutations(actualFrom, actualTo, transferAmount)

                    const request: ExecuteWithHooksRequest = {
                        operation: "transfer",
                        operationData: { from: actualFrom, to: actualTo, amount: transferAmount },
                        tokenAddress,
                        tokenData,
                        scriptCode: token.script.code,
                        txContext: this.buildHookTxContext(tx),
                        nativeOperationMutations: nativeMutations,
                    }

                    const result: HookExecutionResult = await hookExecutor.executeWithHooks(request)
                    if (result.rejection) {
                        return {
                            success: false,
                            message: `Transfer rejected by ${result.rejection.hookType}: ${result.rejection.reason}`,
                        }
                    }

                    this.applyGCRTokenDataToEntity(token, result.finalState)
                } catch (error) {
                    return { success: false, message: `Script execution failed: ${error}` }
                }
            } else {
                // Self-transfers are a no-op for balances (prevents accidental minting)
                if (!isSelfTransfer) {
                    token.balances[actualFrom] = (fromBalance - transferAmount).toString()
                    token.balances[actualTo] = (prevToBalance + transferAmount).toString()
                }
            }

            if (token.balances[actualFrom] === "0") delete token.balances[actualFrom]
            return { success: true, message: "Transfer completed" }
        }

        // Non-simulated execution must be serialized per-token to prevent lost updates when multiple
        // block sync/apply paths touch the same token concurrently.
        let tokenMetaForLog: TokenHolderReference | null = null

        try {
            await gcrTokenRepository.manager.transaction(async em => {
                const repo = em.getRepository(GCRToken)
                const token = await repo.findOne({
                    where: { address: tokenAddress },
                    lock: { mode: "pessimistic_write" },
                })

                if (!token) throw new Error("Token not found: " + tokenAddress)
                if (token.paused && !edit.isRollback) throw new Error("Token is paused")

                const fromBefore = BigInt(token.balances[actualFrom] ?? "0")
                const toBefore = BigInt(token.balances[actualTo] ?? "0")
                if (fromBefore < transferAmount) throw new Error("Insufficient balance")

                const tokenMeta: TokenHolderReference = { tokenAddress, ticker: token.ticker, name: token.name, decimals: token.decimals }
                const beforeByAddr: Record<string, bigint> = {}
                const recordBefore = (mutations: TokenMutation[]) => {
                    const affected = this.collectAddressesFromMutations(mutations)
                    for (const addr of affected) beforeByAddr[addr] = BigInt(token.balances[addr] ?? "0")
                }

                if (token.hasScript && token.script?.code && tx && !edit.isRollback) {
                    const hookExecutor = this.getHookExecutor()
                    const tokenData = this.tokenToGCRTokenData(token)
                    const nativeMutations = isSelfTransfer
                        ? []
                        : createTransferMutations(actualFrom, actualTo, transferAmount)

                    const request: ExecuteWithHooksRequest = {
                        operation: "transfer",
                        operationData: { from: actualFrom, to: actualTo, amount: transferAmount },
                        tokenAddress,
                        tokenData,
                        scriptCode: token.script.code,
                        txContext: this.buildHookTxContext(tx),
                        nativeOperationMutations: nativeMutations,
                    }

                    const result: HookExecutionResult = await hookExecutor.executeWithHooks(request)
                    if (result.rejection) {
                        throw new Error(
                            `Transfer rejected by ${result.rejection.hookType}: ${result.rejection.reason}`,
                        )
                    }

                    recordBefore(result.mutations)
                    this.applyGCRTokenDataToEntity(token, result.finalState)
                } else {
                    const nativeMutations = isSelfTransfer
                        ? []
                        : createTransferMutations(actualFrom, actualTo, transferAmount)
                    recordBefore(nativeMutations)
                    // Self-transfers are a no-op for balances (prevents accidental minting)
                    if (!isSelfTransfer) {
                        token.balances[actualFrom] = (fromBefore - transferAmount).toString()
                        token.balances[actualTo] = (toBefore + transferAmount).toString()
                    }
                }

                if (token.balances[actualFrom] === "0") delete token.balances[actualFrom]

                await repo.save(token)

                const adds: string[] = []
                const removes: string[] = []
                for (const [addr, before] of Object.entries(beforeByAddr)) {
                    const after = BigInt(token.balances[addr] ?? "0")
                    if (before === 0n && after > 0n) adds.push(addr)
                    if (before > 0n && after === 0n) removes.push(addr)
                }

                tokenMetaForLog = tokenMeta
                for (const addr of removes) {
                    await this.removeHolderReference(addr, tokenAddress, em)
                }
                for (const addr of adds) {
                    await this.addHolderReference(addr, tokenMeta, em)
                }
            })

            log.info(
                "[GCRTokenRoutines] Transferred " +
                    amount +
                    " " +
                    tokenMetaForLog?.ticker +
                    " from " +
                    actualFrom +
                    " to " +
                    actualTo,
            )
        } catch (error) {
            log.error("[GCRTokenRoutines] Failed to transfer: " + error)
            return { success: false, message: "Failed to save transfer" }
        }

        return { success: true, message: "Transfer completed" }
    }

    /**
     * Handle token minting - increases supply and target balance
     */
    private static async handleMintToken(
        edit: GCREditTokenMint,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction, // REVIEW: Phase 5.1 - Transaction context for hook execution
    ): Promise<GCRResult> {
        const { to, amount } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Mint: " + amount + " to " + to + " for token " + tokenAddress,
        )

        const mintAmount = BigInt(amount)
        if (mintAmount <= 0n) {
            return { success: false, message: "Mint amount must be positive" }
        }

        // Simulate mode: validate deterministically without persisting.
        if (simulate) {
            const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
            if (!token) return { success: false, message: "Token not found: " + tokenAddress }
            if (token.paused && !edit.isRollback) return { success: false, message: "Token is paused" }
            if (!edit.isRollback && !hasPermission(token.toAccessControl(), edit.account, "canMint")) {
                return { success: false, message: "No mint permission" }
            }

            const prevBalance = BigInt(token.balances[to] ?? "0")
            if (edit.isRollback) {
                if (prevBalance < mintAmount) {
                    return { success: false, message: "Cannot rollback: insufficient balance" }
                }
                token.balances[to] = (prevBalance - mintAmount).toString()
                token.totalSupply = (BigInt(token.totalSupply) - mintAmount).toString()
                if (token.balances[to] === "0") delete token.balances[to]
            } else if (token.hasScript && token.script?.code && tx) {
                try {
                    const hookExecutor = this.getHookExecutor()
                    const tokenData = this.tokenToGCRTokenData(token)
                    const nativeMutations = createMintMutations(to, mintAmount)

                    const request: ExecuteWithHooksRequest = {
                        operation: "mint",
                        operationData: { to, amount: mintAmount },
                        tokenAddress,
                        tokenData,
                        scriptCode: token.script.code,
                        txContext: this.buildHookTxContext(tx),
                        nativeOperationMutations: nativeMutations,
                    }

                    const result: HookExecutionResult = await hookExecutor.executeWithHooks(request)
                    if (result.rejection) {
                        return {
                            success: false,
                            message: `Mint rejected by ${result.rejection.hookType}: ${result.rejection.reason}`,
                        }
                    }
                    this.applyGCRTokenDataToEntity(token, result.finalState)
                } catch (error) {
                    return { success: false, message: `Script execution failed: ${error}` }
                }
            } else {
                token.balances[to] = (prevBalance + mintAmount).toString()
                token.totalSupply = (BigInt(token.totalSupply) + mintAmount).toString()
            }

            return { success: true, message: "Mint completed" }
        }

        try {
            await gcrTokenRepository.manager.transaction(async em => {
                const repo = em.getRepository(GCRToken)
                const token = await repo.findOne({
                    where: { address: tokenAddress },
                    lock: { mode: "pessimistic_write" },
                })

                if (!token) throw new Error("Token not found: " + tokenAddress)
                if (token.paused && !edit.isRollback) throw new Error("Token is paused")
                if (!edit.isRollback && !hasPermission(token.toAccessControl(), edit.account, "canMint")) {
                    throw new Error("No mint permission")
                }

                const prevBalance = BigInt(token.balances[to] ?? "0")
                const supplyBefore = BigInt(token.totalSupply ?? "0")

                const tokenMeta: TokenHolderReference = { tokenAddress, ticker: token.ticker, name: token.name, decimals: token.decimals }
                const beforeByAddr: Record<string, bigint> = {}
                const recordBefore = (mutations: TokenMutation[]) => {
                    const affected = this.collectAddressesFromMutations(mutations)
                    for (const addr of affected) beforeByAddr[addr] = BigInt(token.balances[addr] ?? "0")
                }

                if (edit.isRollback) {
                    recordBefore([{ kind: "burn", from: to, amount: mintAmount }])
                    if (prevBalance < mintAmount) throw new Error("Cannot rollback: insufficient balance")
                    token.balances[to] = (prevBalance - mintAmount).toString()
                    token.totalSupply = (supplyBefore - mintAmount).toString()
                    if (token.balances[to] === "0") delete token.balances[to]
                } else if (token.hasScript && token.script?.code && tx) {
                    const hookExecutor = this.getHookExecutor()
                    const tokenData = this.tokenToGCRTokenData(token)
                    const nativeMutations = createMintMutations(to, mintAmount)

                    const request: ExecuteWithHooksRequest = {
                        operation: "mint",
                        operationData: { to, amount: mintAmount },
                        tokenAddress,
                        tokenData,
                        scriptCode: token.script.code,
                        txContext: this.buildHookTxContext(tx),
                        nativeOperationMutations: nativeMutations,
                    }

                    const result: HookExecutionResult = await hookExecutor.executeWithHooks(request)
                    if (result.rejection) {
                        throw new Error(`Mint rejected by ${result.rejection.hookType}: ${result.rejection.reason}`)
                    }
                    recordBefore(result.mutations)
                    this.applyGCRTokenDataToEntity(token, result.finalState)
                } else {
                    recordBefore(createMintMutations(to, mintAmount))
                    token.balances[to] = (prevBalance + mintAmount).toString()
                    token.totalSupply = (supplyBefore + mintAmount).toString()
                }

                await repo.save(token)

                const adds: string[] = []
                const removes: string[] = []
                for (const [addr, before] of Object.entries(beforeByAddr)) {
                    const after = BigInt(token.balances[addr] ?? "0")
                    if (before === 0n && after > 0n) adds.push(addr)
                    if (before > 0n && after === 0n) removes.push(addr)
                }
                for (const addr of removes) await this.removeHolderReference(addr, tokenAddress, em)
                for (const addr of adds) await this.addHolderReference(addr, tokenMeta, em)
            })

            log.info("[GCRTokenRoutines] Minted " + amount + " to " + to + " for " + tokenAddress)
        } catch (error) {
            log.error("[GCRTokenRoutines] Failed to mint: " + error)
            return { success: false, message: "Failed to save mint" }
        }

        return { success: true, message: "Mint completed" }
    }

    /**
     * Handle token burning - decreases supply and target balance
     */
    private static async handleBurnToken(
        edit: GCREditTokenBurn,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction, // REVIEW: Phase 5.1 - Transaction context for hook execution
    ): Promise<GCRResult> {
        const { from, amount } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Burn: " + amount + " from " + from + " for token " + tokenAddress,
        )

        const burnAmount = BigInt(amount)
        if (burnAmount <= 0n) {
            return { success: false, message: "Burn amount must be positive" }
        }

        if (simulate) {
            const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
            if (!token) return { success: false, message: "Token not found: " + tokenAddress }
            if (token.paused && !edit.isRollback) return { success: false, message: "Token is paused" }
            if (!edit.isRollback && edit.account !== from) {
                if (!hasPermission(token.toAccessControl(), edit.account, "canBurn")) {
                    return { success: false, message: "No burn permission" }
                }
            }

            const prevBalance = BigInt(token.balances[from] ?? "0")
            if (edit.isRollback) {
                token.balances[from] = (prevBalance + burnAmount).toString()
                token.totalSupply = (BigInt(token.totalSupply) + burnAmount).toString()
            } else if (token.hasScript && token.script?.code && tx) {
                if (prevBalance < burnAmount) return { success: false, message: "Insufficient balance to burn" }
                try {
                    const hookExecutor = this.getHookExecutor()
                    const tokenData = this.tokenToGCRTokenData(token)
                    const nativeMutations = createBurnMutations(from, burnAmount)
                    const request: ExecuteWithHooksRequest = {
                        operation: "burn",
                        operationData: { from, amount: burnAmount },
                        tokenAddress,
                        tokenData,
                        scriptCode: token.script.code,
                        txContext: this.buildHookTxContext(tx),
                        nativeOperationMutations: nativeMutations,
                    }
                    const result: HookExecutionResult = await hookExecutor.executeWithHooks(request)
                    if (result.rejection) {
                        return {
                            success: false,
                            message: `Burn rejected by ${result.rejection.hookType}: ${result.rejection.reason}`,
                        }
                    }
                    this.applyGCRTokenDataToEntity(token, result.finalState)
                } catch (error) {
                    return { success: false, message: `Script execution failed: ${error}` }
                }
            } else {
                if (prevBalance < burnAmount) return { success: false, message: "Insufficient balance to burn" }
                token.balances[from] = (prevBalance - burnAmount).toString()
                token.totalSupply = (BigInt(token.totalSupply) - burnAmount).toString()
                if (token.balances[from] === "0") delete token.balances[from]
            }

            return { success: true, message: "Burn completed" }
        }

        try {
            await gcrTokenRepository.manager.transaction(async em => {
                const repo = em.getRepository(GCRToken)
                const token = await repo.findOne({
                    where: { address: tokenAddress },
                    lock: { mode: "pessimistic_write" },
                })

                if (!token) throw new Error("Token not found: " + tokenAddress)
                if (token.paused && !edit.isRollback) throw new Error("Token is paused")
                if (!edit.isRollback && edit.account !== from) {
                    if (!hasPermission(token.toAccessControl(), edit.account, "canBurn")) {
                        throw new Error("No burn permission")
                    }
                }

                const prevBalance = BigInt(token.balances[from] ?? "0")
                const supplyBefore = BigInt(token.totalSupply ?? "0")

                const tokenMeta: TokenHolderReference = { tokenAddress, ticker: token.ticker, name: token.name, decimals: token.decimals }
                const beforeByAddr: Record<string, bigint> = {}
                const recordBefore = (mutations: TokenMutation[]) => {
                    const affected = this.collectAddressesFromMutations(mutations)
                    for (const addr of affected) beforeByAddr[addr] = BigInt(token.balances[addr] ?? "0")
                }

                if (edit.isRollback) {
                    recordBefore([{ kind: "mint", to: from, amount: burnAmount }])
                    token.balances[from] = (prevBalance + burnAmount).toString()
                    token.totalSupply = (supplyBefore + burnAmount).toString()
                } else if (token.hasScript && token.script?.code && tx) {
                    if (prevBalance < burnAmount) throw new Error("Insufficient balance to burn")

                    const hookExecutor = this.getHookExecutor()
                    const tokenData = this.tokenToGCRTokenData(token)
                    const nativeMutations = createBurnMutations(from, burnAmount)
                    const request: ExecuteWithHooksRequest = {
                        operation: "burn",
                        operationData: { from, amount: burnAmount },
                        tokenAddress,
                        tokenData,
                        scriptCode: token.script.code,
                        txContext: this.buildHookTxContext(tx),
                        nativeOperationMutations: nativeMutations,
                    }

                    const result: HookExecutionResult = await hookExecutor.executeWithHooks(request)
                    if (result.rejection) {
                        throw new Error(`Burn rejected by ${result.rejection.hookType}: ${result.rejection.reason}`)
                    }
                    recordBefore(result.mutations)
                    this.applyGCRTokenDataToEntity(token, result.finalState)
                } else {
                    recordBefore(createBurnMutations(from, burnAmount))
                    if (prevBalance < burnAmount) throw new Error("Insufficient balance to burn")
                    token.balances[from] = (prevBalance - burnAmount).toString()
                    token.totalSupply = (supplyBefore - burnAmount).toString()
                    if (token.balances[from] === "0") delete token.balances[from]
                }

                await repo.save(token)

                const adds: string[] = []
                const removes: string[] = []
                for (const [addr, before] of Object.entries(beforeByAddr)) {
                    const after = BigInt(token.balances[addr] ?? "0")
                    if (before === 0n && after > 0n) adds.push(addr)
                    if (before > 0n && after === 0n) removes.push(addr)
                }
                for (const addr of removes) await this.removeHolderReference(addr, tokenAddress, em)
                for (const addr of adds) await this.addHolderReference(addr, tokenMeta, em)
            })

            log.info("[GCRTokenRoutines] Burned " + amount + " from " + from + " for " + tokenAddress)
        } catch (error) {
            log.error("[GCRTokenRoutines] Failed to burn: " + error)
            return { success: false, message: "Failed to save burn" }
        }

        return { success: true, message: "Burn completed" }
    }

    /**
     * Handle pausing a token
     */
    private static async handlePauseToken(
        edit: GCREditTokenPause,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const tokenAddress = edit.tokenAddress

        log.debug("[GCRTokenRoutines] Pause token: " + tokenAddress)

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        if (!edit.isRollback) {
            if (!hasPermission(token.toAccessControl(), edit.account, "canPause")) {
                return { success: false, message: "No pause permission" }
            }
        }

        // For rollback, unpause; otherwise pause
        token.paused = !edit.isRollback

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                const action = edit.isRollback ? "Unpaused" : "Paused"
                log.info("[GCRTokenRoutines] " + action + " token " + tokenAddress)
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to pause: " + error)
                return { success: false, message: "Failed to save pause state" }
            }
        }

        return { success: true, message: edit.isRollback ? "Token unpaused" : "Token paused" }
    }

    /**
     * Handle unpausing a token
     */
    private static async handleUnpauseToken(
        edit: GCREditTokenUnpause,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const tokenAddress = edit.tokenAddress

        log.debug("[GCRTokenRoutines] Unpause token: " + tokenAddress)

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        if (!edit.isRollback) {
            if (!hasPermission(token.toAccessControl(), edit.account, "canPause")) {
                return { success: false, message: "No pause permission" }
            }
        }

        // For rollback, pause; otherwise unpause
        token.paused = edit.isRollback

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                const action = edit.isRollback ? "Paused" : "Unpaused"
                log.info("[GCRTokenRoutines] " + action + " token " + tokenAddress)
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to unpause: " + error)
                return { success: false, message: "Failed to save pause state" }
            }
        }

        return { success: true, message: edit.isRollback ? "Token paused" : "Token unpaused" }
    }

    /**
     * Handle ACL updates - grant or revoke permissions
     */
    private static async handleUpdateTokenACL(
        edit: GCREditTokenUpdateACL,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction,
    ): Promise<GCRResult> {
        const { action, targetAddress, permissions } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] ACL update: " +
                action +
                " " +
                permissions.join(",") +
                " for " +
                targetAddress,
        )

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        if (!edit.isRollback) {
            if (!hasPermission(token.toAccessControl(), edit.account, "canModifyACL")) {
                return { success: false, message: "No ACL modification permission" }
            }
        }

        // Determine actual action (flip for rollback)
        const actualAction = edit.isRollback
            ? (action === "grant" ? "revoke" : "grant")
            : action

        if (actualAction === "grant") {
            const grantedAt = this.getDeterministicTxTimestamp(tx)
            // Find or create entry
            let entry = token.aclEntries.find((e) => e.address === targetAddress)
            if (!entry) {
                entry = {
                    address: targetAddress,
                    permissions: [],
                    grantedAt,
                    grantedBy: edit.account,
                }
                token.aclEntries.push(entry)
            }
            // Add permissions
            for (const perm of permissions) {
                if (!entry.permissions.includes(perm)) {
                    entry.permissions.push(perm)
                }
            }
        } else {
            // Revoke
            const entry = token.aclEntries.find((e) => e.address === targetAddress)
            if (entry) {
                entry.permissions = entry.permissions.filter(
                    (p) => !permissions.includes(p as TokenPermission),
                )
                // Remove entry if no permissions left
                if (entry.permissions.length === 0) {
                    token.aclEntries = token.aclEntries.filter(
                        (e) => e.address !== targetAddress,
                    )
                }
            }
        }

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                log.info(
                    "[GCRTokenRoutines] ACL " +
                        actualAction +
                        "ed " +
                        permissions.join(",") +
                        " for " +
                        targetAddress,
                )
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to update ACL: " + error)
                return { success: false, message: "Failed to save ACL update" }
            }
        }

        return { success: true, message: "ACL " + actualAction + " completed" }
    }

    // REVIEW: Phase 4.2 - Dedicated Grant/Revoke Permission handlers

    /**
     * Handle granting permissions to an address.
     * This is a specialized form of updateACL for grant operations.
     *
     * @param edit - GCREdit operation for granting permission
     * @param gcrTokenRepository - Token repository
     * @param simulate - Whether to simulate without persisting
     * @returns GCRResult indicating success or failure
     */
    private static async handleGrantPermission(
        edit: GCREditTokenGrantPermission,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction,
    ): Promise<GCRResult> {
        const { grantee, permissions } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Grant permission: " +
                permissions.join(",") +
                " to " +
                grantee +
                " on " +
                tokenAddress,
        )

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        if (!edit.isRollback) {
            if (!hasPermission(token.toAccessControl(), edit.account, "canModifyACL")) {
                return { success: false, message: "No ACL modification permission" }
            }
        }

        // For rollback, we revoke instead of grant
        if (edit.isRollback) {
            // Revoke the permissions
            const entry = token.aclEntries.find((e) => e.address === grantee)
            if (entry) {
                entry.permissions = entry.permissions.filter(
                    (p) => !permissions.includes(p as TokenPermission),
                )
                // Remove entry if no permissions left
                if (entry.permissions.length === 0) {
                    token.aclEntries = token.aclEntries.filter((e) => e.address !== grantee)
                }
            }
        } else {
            // Normal grant
            const grantedAt = this.getDeterministicTxTimestamp(tx)
            let entry = token.aclEntries.find((e) => e.address === grantee)
            if (!entry) {
                entry = {
                    address: grantee,
                    permissions: [],
                    grantedAt,
                    grantedBy: edit.account,
                }
                token.aclEntries.push(entry)
            }
            // Add permissions
            for (const perm of permissions) {
                if (!entry.permissions.includes(perm)) {
                    entry.permissions.push(perm)
                }
            }
        }

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                const action = edit.isRollback ? "Revoked (rollback)" : "Granted"
                log.info(
                    "[GCRTokenRoutines] " +
                        action +
                        " " +
                        permissions.join(",") +
                        " to " +
                        grantee,
                )
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to grant permission: " + error)
                return { success: false, message: "Failed to save permission grant" }
            }
        }

        return {
            success: true,
            message: edit.isRollback ? "Permission revoked (rollback)" : "Permission granted",
        }
    }

    /**
     * Handle revoking permissions from an address.
     * This is a specialized form of updateACL for revoke operations.
     *
     * @param edit - GCREdit operation for revoking permission
     * @param gcrTokenRepository - Token repository
     * @param simulate - Whether to simulate without persisting
     * @returns GCRResult indicating success or failure
     */
    private static async handleRevokePermission(
        edit: GCREditTokenRevokePermission,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction,
    ): Promise<GCRResult> {
        const { grantee, permissions } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Revoke permission: " +
                permissions.join(",") +
                " from " +
                grantee +
                " on " +
                tokenAddress,
        )

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        if (!edit.isRollback) {
            if (!hasPermission(token.toAccessControl(), edit.account, "canModifyACL")) {
                return { success: false, message: "No ACL modification permission" }
            }
        }

        // For rollback, we grant instead of revoke
        if (edit.isRollback) {
            // Re-grant the permissions
            const grantedAt = this.getDeterministicTxTimestamp(tx)
            let entry = token.aclEntries.find((e) => e.address === grantee)
            if (!entry) {
                entry = {
                    address: grantee,
                    permissions: [],
                    grantedAt,
                    grantedBy: edit.account,
                }
                token.aclEntries.push(entry)
            }
            for (const perm of permissions) {
                if (!entry.permissions.includes(perm)) {
                    entry.permissions.push(perm)
                }
            }
        } else {
            // Normal revoke
            const entry = token.aclEntries.find((e) => e.address === grantee)
            if (entry) {
                entry.permissions = entry.permissions.filter(
                    (p) => !permissions.includes(p as TokenPermission),
                )
                // Remove entry if no permissions left
                if (entry.permissions.length === 0) {
                    token.aclEntries = token.aclEntries.filter((e) => e.address !== grantee)
                }
            }
        }

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                const action = edit.isRollback ? "Granted (rollback)" : "Revoked"
                log.info(
                    "[GCRTokenRoutines] " +
                        action +
                        " " +
                        permissions.join(",") +
                        " from " +
                        grantee,
                )
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to revoke permission: " + error)
                return { success: false, message: "Failed to save permission revoke" }
            }
        }

        return {
            success: true,
            message: edit.isRollback ? "Permission granted (rollback)" : "Permission revoked",
        }
    }

    /**
     * Handle script upgrade
     */
    private static async handleUpgradeTokenScript(
        edit: GCREditTokenUpgradeScript,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction,
    ): Promise<GCRResult> {
        const { newScript, upgradeReason, previousVersion } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug("[GCRTokenRoutines] Upgrade script for token: " + tokenAddress)

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        // Authorization: Must be owner OR have canUpgrade permission in ACL
        if (!edit.isRollback) {
            if (!hasPermission(token.toAccessControl(), edit.account, "canUpgrade")) {
                return { success: false, message: "No upgrade permission" }
            }
        }

        // Store previous version for logging/rollback reference
        const currentVersion = token.scriptVersion ?? 0
        const currentTimestamp = this.getDeterministicTxTimestamp(tx)

        // For rollback, attempt to restore previous version state
        if (edit.isRollback) {
            // If previousVersion was provided, use it to decrement
            if (previousVersion !== undefined && previousVersion >= 0) {
                token.scriptVersion = previousVersion
                log.info(
                    "[GCRTokenRoutines] Script rollback to version " +
                        previousVersion +
                        " for " +
                        tokenAddress,
                )
            } else {
                // Without previous version info, we can only clear the script
                log.warn(
                    "[GCRTokenRoutines] Script rollback without version info - clearing script",
                )
                token.script = undefined
                token.hasScript = false
                token.scriptVersion = 0
                token.lastScriptUpdate = null
            }
        } else {
            // Normal upgrade: increment version and update script
            token.script = newScript
            token.hasScript = true
            token.scriptVersion = currentVersion + 1
            token.lastScriptUpdate = currentTimestamp

            // Log upgrade reason if provided
            if (upgradeReason) {
                log.info(
                    "[GCRTokenRoutines] Upgrade reason for " +
                        tokenAddress +
                        ": " +
                        upgradeReason,
                )
            }
        }

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                const action = edit.isRollback ? "Rolled back" : "Upgraded"
                const versionInfo = edit.isRollback
                    ? "from v" + currentVersion
                    : "to v" + token.scriptVersion

                log.info(
                    "[GCRTokenRoutines] " +
                        action +
                        " script " +
                        versionInfo +
                        " for " +
                        tokenAddress,
                )
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to upgrade script: " + error)
                return { success: false, message: "Failed to save script upgrade" }
            }
        }

        return {
            success: true,
            message: edit.isRollback
                ? "Script rolled back to v" + token.scriptVersion
                : "Script upgraded to v" + token.scriptVersion,
            response: {
                previousVersion: currentVersion,
                newVersion: token.scriptVersion,
                upgradedAt: token.lastScriptUpdate,
            },
        }
    }

    /**
     * Handle ownership transfer
     */
    private static async handleTransferOwnership(
        edit: GCREditTokenTransferOwnership,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { newOwner } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Transfer ownership to " +
                newOwner +
                " for token: " +
                tokenAddress,
        )

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check permission (unless rollback)
        if (!edit.isRollback) {
            if (
                !hasPermission(token.toAccessControl(), edit.account, "canTransferOwnership")
            ) {
                return { success: false, message: "No ownership transfer permission" }
            }
        }

        const oldOwner = token.owner

        // For rollback, swap back
        if (edit.isRollback) {
            token.owner = edit.account // Previous owner was the caller
        } else {
            token.owner = newOwner
        }

        if (!simulate) {
            try {
                await gcrTokenRepository.save(token)
                log.info(
                    "[GCRTokenRoutines] Transferred ownership from " +
                        oldOwner +
                        " to " +
                        token.owner,
                )
            } catch (error) {
                log.error("[GCRTokenRoutines] Failed to transfer ownership: " + error)
                return { success: false, message: "Failed to save ownership transfer" }
            }
        }

        return { success: true, message: "Ownership transferred" }
    }

    // REVIEW: Phase 5.2 - Custom Script Method Execution

    /**
     * Handle custom script method execution.
     * This enables user-defined write operations beyond native operations.
     *
     * @param edit - GCREdit operation for custom method
     * @param gcrTokenRepository - Token repository
     * @param simulate - Whether to simulate without persisting
     * @param tx - Optional transaction context for script execution
     * @returns GCRResult indicating success or failure
     */
    private static async handleCustomMethod(
        edit: GCREditTokenCustom,
        gcrTokenRepository: Repository<GCRToken>,
        simulate: boolean,
        tx?: Transaction,
    ): Promise<GCRResult> {
        const { method, params } = edit.data
        const tokenAddress = edit.tokenAddress

        log.debug(
            "[GCRTokenRoutines] Custom method: " +
                method +
                " on token: " +
                tokenAddress,
        )

        // Get token
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return { success: false, message: "Token not found: " + tokenAddress }
        }

        // Check if token has a script
        if (!token.hasScript || !token.script) {
            return {
                success: false,
                message: "Token has no script - custom methods not available",
            }
        }

        // Check if method is defined in the script
        const methodDef = token.script.methods?.find((m) => m.name === method)
        if (!methodDef) {
            return {
                success: false,
                message: "Method not found in script: " + method,
            }
        }

        // Verify method is a write operation (not view-only)
        // TokenScriptMethod uses `mutates: boolean` - methods with mutates=false are view-only
        if (!methodDef.mutates) {
            return {
                success: false,
                message: "Cannot invoke view method as transaction: " + method,
            }
        }

        // Rollback not supported for custom methods (script state is opaque)
        if (edit.isRollback) {
            log.warn(
                "[GCRTokenRoutines] Rollback not fully supported for custom method: " +
                    method,
            )
            // For now, we skip rollback - proper rollback would need mutation logging
            return {
                success: true,
                message: "Custom method rollback skipped (state opaque)",
            }
        }

        // Prepare block context for script execution
        // Note: getSharedState is a getter that returns SharedState instance directly
        const sharedState = getSharedState
        const blockContext = {
            timestamp: this.getDeterministicTxTimestamp(tx),
            height: sharedState.lastBlockNumber ?? 0,
            prevBlockHash: sharedState.lastBlockHash ?? "0".repeat(64),
        }

        // Prepare script execution request
        const tokenData = this.tokenToGCRTokenData(token)

        try {
            // Execute the custom method via ScriptExecutor
            const result = await scriptExecutor.executeMethod({
                tokenAddress,
                method,
                args: params,
                caller: edit.account,
                blockContext,
                txHash: edit.txhash,
                tokenData,
                scriptCode: token.script.code,
            })

            // ScriptResult is a discriminated union - check success first
            if (!result.success) {
                // TypeScript needs explicit type extraction for discriminated union narrowing
                const errorResult = result as Extract<typeof result, { success: false }>
                log.error(
                    "[GCRTokenRoutines] Custom method execution failed: " +
                        errorResult.error,
                )
                return {
                    success: false,
                    message: errorResult.error ?? "Script execution failed",
                }
            }

            // TypeScript now knows result is ScriptSuccess
            // Apply state mutations from script execution using applyMutations
            if (result.mutations.length > 0 && !simulate) {
                // Apply mutations to get new state
                const { newState } = applyMutations(tokenData, result.mutations)
                this.applyGCRTokenDataToEntity(token, newState)

                try {
                    await gcrTokenRepository.save(token)
                    log.info(
                        "[GCRTokenRoutines] Custom method " +
                            method +
                            " executed on " +
                            tokenAddress,
                    )
                } catch (error) {
                    log.error(
                        "[GCRTokenRoutines] Failed to save custom method state: " +
                            error,
                    )
                    return {
                        success: false,
                        message: "Failed to persist custom method state",
                    }
                }
            }

            return {
                success: true,
                message: "Custom method executed: " + method,
                response: {
                    method,
                    returnValue: result.returnValue,
                    mutations: result.mutations.length,
                },
            }
        } catch (error) {
            log.error(
                "[GCRTokenRoutines] Custom method execution error: " + error,
            )
            return {
                success: false,
                message: "Custom method execution error: " + String(error),
            }
        }
    }

    // SECTION: Helper Methods

    /**
     * Add a holder reference to GCRMain.extended.tokens
     */
    private static async addHolderReference(
        holderAddress: string,
        reference: TokenHolderReference,
        em?: EntityManager,
    ): Promise<void> {
        try {
            if (em) {
                const repo = em.getRepository(GCRMain)
                let holder = await repo.findOne({
                    where: { pubkey: holderAddress },
                    lock: { mode: "pessimistic_write" },
                })

                if (!holder) {
                    holder = await repo.save(
                        this.buildEmptyHolderAccount(holderAddress),
                    )
                }

                const current = holder.extended ?? {
                    tokens: [],
                    nfts: [],
                    xm: [],
                    web2: [],
                    other: [],
                }
                const tokens = Array.isArray(current.tokens) ? current.tokens : []

                const idx = tokens.findIndex(
                    (t: any) => t?.tokenAddress === reference.tokenAddress,
                )
                if (idx >= 0) {
                    tokens[idx] = { ...tokens[idx], ...reference }
                } else {
                    tokens.push(reference)
                }

                holder.extended = { ...current, tokens }
                await repo.save(holder)
                return
            }

            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const gcrMainRepository = dataSource.getRepository(GCRMain)

            // Ensure the holder account exists so pointer operations are not dropped.
            const existing = await gcrMainRepository.findOneBy({ pubkey: holderAddress })
            if (!existing) {
                await ensureGCRForUser(holderAddress)
            }

            await dataSource.transaction(async em => {
                const repo = em.getRepository(GCRMain)
                const holder = await repo.findOne({
                    where: { pubkey: holderAddress },
                    lock: { mode: "pessimistic_write" },
                })

                if (!holder) {
                    log.debug(
                        "[GCRTokenRoutines] Holder " +
                            holderAddress +
                            " not found after ensureGCRForUser, skipping reference add",
                    )
                    return
                }

                const current = holder.extended ?? {
                    tokens: [],
                    nfts: [],
                    xm: [],
                    web2: [],
                    other: [],
                }
                const tokens = Array.isArray(current.tokens) ? current.tokens : []

                const idx = tokens.findIndex(
                    (t: any) => t?.tokenAddress === reference.tokenAddress,
                )
                if (idx >= 0) {
                    tokens[idx] = { ...tokens[idx], ...reference }
                } else {
                    tokens.push(reference)
                }

                holder.extended = { ...current, tokens }
                await repo.save(holder)
            })
        } catch (error) {
            log.error("[GCRTokenRoutines] Failed to add holder reference: " + error)
        }
    }

    /**
     * Remove a holder reference from GCRMain.extended.tokens
     */
    private static async removeHolderReference(
        holderAddress: string,
        tokenAddress: string,
        em?: EntityManager,
    ): Promise<void> {
        try {
            if (em) {
                const repo = em.getRepository(GCRMain)
                const locked = await repo.findOne({
                    where: { pubkey: holderAddress },
                    lock: { mode: "pessimistic_write" },
                })
                if (!locked) return

                const current = locked.extended ?? {
                    tokens: [],
                    nfts: [],
                    xm: [],
                    web2: [],
                    other: [],
                }
                const tokens = Array.isArray(current.tokens) ? current.tokens : []
                const next = tokens.filter((t: any) => t?.tokenAddress !== tokenAddress)

                locked.extended = { ...current, tokens: next }
                await repo.save(locked)
                return
            }

            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const gcrMainRepository = dataSource.getRepository(GCRMain)

            const holder = await gcrMainRepository.findOneBy({
                pubkey: holderAddress,
            })
            if (!holder) {
                log.debug(
                    "[GCRTokenRoutines] Holder " +
                        holderAddress +
                        " not found, skipping reference remove",
                )
                return
            }

            await dataSource.transaction(async em => {
                const repo = em.getRepository(GCRMain)
                const locked = await repo.findOne({
                    where: { pubkey: holderAddress },
                    lock: { mode: "pessimistic_write" },
                })
                if (!locked) return

                const current = locked.extended ?? {
                    tokens: [],
                    nfts: [],
                    xm: [],
                    web2: [],
                    other: [],
                }
                const tokens = Array.isArray(current.tokens) ? current.tokens : []
                const next = tokens.filter((t: any) => t?.tokenAddress !== tokenAddress)

                locked.extended = { ...current, tokens: next }
                await repo.save(locked)
            })
        } catch (error) {
            log.error("[GCRTokenRoutines] Failed to remove holder reference: " + error)
        }
    }

    private static collectAddressesFromMutations(mutations: TokenMutation[]): Set<string> {
        const out = new Set<string>()
        for (const m of mutations ?? []) {
            if (!m || typeof m !== "object") continue
            if (m.kind === "transfer") {
                if (m.from) out.add(m.from)
                if (m.to) out.add(m.to)
            } else if (m.kind === "mint") {
                if (m.to) out.add(m.to)
            } else if (m.kind === "burn") {
                if (m.from) out.add(m.from)
            }
        }
        return out
    }

    // SECTION: Query Methods (for nodeCall)

    /**
     * Get token by address
     */
    static async getToken(
        tokenAddress: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<GCRToken | null> {
        return gcrTokenRepository.findOneBy({ address: tokenAddress })
    }

    /**
     * Get token balance for a holder
     */
    static async getBalance(
        tokenAddress: string,
        holderAddress: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<{ balance: string; decimals: number; ticker: string } | null> {
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return null
        }
        return {
            balance: token.balances[holderAddress] ?? "0",
            decimals: token.decimals,
            ticker: token.ticker,
        }
    }

    /**
     * Get all tokens by deployer
     */
    static async getTokensByDeployer(
        deployerAddress: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<GCRToken[]> {
        return gcrTokenRepository.findBy({ deployer: deployerAddress })
    }

    // REVIEW: Phase 1.6 - Additional query methods for NodeCall

    /**
     * Get allowance for owner -> spender
     */
    static async getAllowance(
        tokenAddress: string,
        ownerAddress: string,
        spenderAddress: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<{ allowance: string; decimals: number; ticker: string } | null> {
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return null
        }
        const ownerAllowances = token.allowances[ownerAddress] ?? {}
        return {
            allowance: ownerAllowances[spenderAddress] ?? "0",
            decimals: token.decimals,
            ticker: token.ticker,
        }
    }

    /**
     * Get all tokens held by an address (by iterating through balances)
     * Note: This is a potentially expensive operation for large token sets.
     * In production, consider using holder reference pointers in GCRMain.
     */
    static async getTokensOf(
        holderAddress: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<Array<{
        tokenAddress: string
        ticker: string
        name: string
        decimals: number
        balance: string
    }>> {
        // Get all tokens and filter by holder balance
        // REVIEW: This is O(n) over all tokens - consider optimizing with holder pointers
        const allTokens = await gcrTokenRepository.find()
        const heldTokens: Array<{
            tokenAddress: string
            ticker: string
            name: string
            decimals: number
            balance: string
        }> = []

        for (const token of allTokens) {
            const balance = token.balances[holderAddress]
            if (balance && BigInt(balance) > 0n) {
                heldTokens.push({
                    tokenAddress: token.address,
                    ticker: token.ticker,
                    name: token.name,
                    decimals: token.decimals,
                    balance,
                })
            }
        }

        return heldTokens
    }

    // REVIEW: Phase 4.2 - Permission checking utilities

    /**
     * Checks if an address has a specific permission on a token.
     * This is the primary utility for permission checking across the codebase.
     *
     * Permission hierarchy:
     * - Owner always has all permissions (implicit)
     * - Other addresses require explicit ACL entries
     * - Empty ACL = only owner can perform protected operations
     *
     * @param tokenAddress - Token to check permissions on
     * @param address - Address to check permissions for
     * @param permission - Permission to check
     * @param gcrTokenRepository - Token repository
     * @returns True if the address has the permission, false otherwise
     */
    static async checkPermission(
        tokenAddress: string,
        address: string,
        permission: TokenPermission,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<boolean> {
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return false
        }

        return hasPermission(token.toAccessControl(), address, permission)
    }

    /**
     * Gets all permissions for an address on a token.
     *
     * @param tokenAddress - Token to check
     * @param address - Address to get permissions for
     * @param gcrTokenRepository - Token repository
     * @returns Array of permissions the address has, or null if token not found
     */
    static async getPermissions(
        tokenAddress: string,
        address: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<TokenPermission[] | null> {
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return null
        }

        // Owner has all permissions
        if (token.owner === address) {
            return [
                "canMint",
                "canBurn",
                "canUpgrade",
                "canPause",
                "canTransferOwnership",
                "canModifyACL",
                "canExecuteScript",
            ]
        }

        // Check ACL entries
        const entry = token.aclEntries.find((e) => e.address === address)
        if (!entry) {
            return []
        }

        return entry.permissions as TokenPermission[]
    }

    /**
     * Gets the full ACL for a token.
     *
     * @param tokenAddress - Token to get ACL for
     * @param gcrTokenRepository - Token repository
     * @returns ACL data or null if token not found
     */
    static async getACL(
        tokenAddress: string,
        gcrTokenRepository: Repository<GCRToken>,
    ): Promise<{
        owner: string
        paused: boolean
        entries: Array<{
            address: string
            permissions: string[]
            grantedAt: number
            grantedBy: string
        }>
    } | null> {
        const token = await gcrTokenRepository.findOneBy({ address: tokenAddress })
        if (!token) {
            return null
        }

        return {
            owner: token.owner,
            paused: token.paused,
            entries: token.aclEntries,
        }
    }
}
