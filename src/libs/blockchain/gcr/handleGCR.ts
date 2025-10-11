// ! Unify this and gcr.ts methods
/** TODO
 * 1. Port here the following methods from gcr.ts:
 *      - assignXM
 *      - assignWeb2
 * 2. Ensure no file calls gcr.ts methods and if so, port them here
 * 3. Add methods for the following:
 *      - update of balance, nonce, txs
 *      - update for tokens, nfts, xm, web2, other
 *      - a parser for GCR updates that calls the above methods
 *      - Use txToOperations to convert transactions to operations
 * 4. Ensure GCRJsonbHandler is used for all JSONB operations
 * 5. Ensure GCRTracker is updated for all operations pertaining to an address
 */

/** NOTE
 * To implement the assign calls, see txToGCR.drawio.png schema to have an idea of how to
 * convert a demosWork in a GCROperation and how to change the GCR with that operation.
 * - Also implement the new GCROperation structure replacing the old Operation one
 */

import { emptyResponse } from "./../../network/server_rpc"
import _ from "lodash"
// NOTE This will replace gcr.ts methods for calling the native tables
import { GCRSubnetsTxs } from "src/model/entities/GCRv2/GCRSubnetsTxs" // TODO Put this in the sdk when done
import { GCRHashes } from "src/model/entities/GCRv2/GCRHashes"
import { RPCResponse, Transaction } from "@kynesyslabs/demosdk/types"
import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import hashGCRTables from "./gcr_routines/hashGCR"
import * as GCRJsonbHandler from "./gcr_routines/gcrJSONBHandler"
import ensureGCRForUser from "./gcr_routines/ensureGCRForUser"
import gcrStateSave from "./gcr_routines/gcrStateSaverHelper"
import { assignXM } from "./gcr_routines/assignXM"
import { assignWeb2 } from "./gcr_routines/assignWeb2"
import IdentityManager from "./gcr_routines/identityManager"
import manageNative from "./gcr_routines/manageNative"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"

// REVIEW Trying to use the new GCRv2
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"
import { GCRTracker } from "src/model/entities/GCR/GCRTracker"
import GCRBalanceRoutines from "./gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "./gcr_routines/GCRNonceRoutines"

import Chain from "../chain"
import { Repository } from "typeorm"
import GCRIdentityRoutines from "./gcr_routines/GCRIdentityRoutines"
import { Referrals } from "@/features/incentive/referrals"
import { validateStorageProgramAccess } from "@/libs/blockchain/validators/validateStorageProgramAccess"
import { getDataSize, STORAGE_LIMITS } from "@/libs/blockchain/validators/validateStorageProgramSize"

export type GetNativeStatusOptions = {
    balance?: boolean
    nonce?: boolean
    txList?: boolean
    identities?: boolean
    extended?: boolean
}

export type GetNativePropertiesOptions = {
    tokens?: boolean
    nfts?: boolean
    xm?: boolean
    web2?: boolean
    other?: boolean
}

export type GetNativeSubnetsTxsOptions = {
    txData?: boolean
}

export interface GCRResult {
    success: boolean
    message: string
    response?: any
}

// ? Maybe sanitize the options?
export default class HandleGCR {
    // TODO Implement this

    static async getNativeStatus(
        publicKey: string,
        options: GetNativeStatusOptions = {
            balance: true,
            nonce: true,
            txList: false,
            identities: true,
            extended: false,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const globalChangeRegistryRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        // Getting the status native data
        const globalChangeRegistrySearch =
            await globalChangeRegistryRepository.findOneBy({
                publicKey: publicKey,
            })
        if (!globalChangeRegistrySearch) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const globalChangeRegistryData: GlobalChangeRegistry = {
            id: globalChangeRegistrySearch.id,
            publicKey: globalChangeRegistrySearch.publicKey,
            details: globalChangeRegistrySearch.details,
            extended: globalChangeRegistrySearch.extended,
        }
        // Selecting only the requested data
        if (options.balance) {
            globalChangeRegistryData.details.content.balance =
                globalChangeRegistrySearch.details.content.balance
        }
        if (options.nonce) {
            globalChangeRegistryData.details.content.nonce =
                globalChangeRegistrySearch.details.content.nonce
        }
        if (options.txList) {
            globalChangeRegistryData.details.content.txs =
                globalChangeRegistrySearch.details.content.txs
        }
        if (options.identities) {
            globalChangeRegistryData.details.content.identities =
                globalChangeRegistrySearch.details.content.identities
        }
        if (options.extended) {
            globalChangeRegistryData.extended =
                globalChangeRegistrySearch.extended
        }
        response.response = globalChangeRegistryData
        return response
    }

    static async getNativeProperties(
        publicKey: string,
        options: GetNativePropertiesOptions = {
            tokens: true,
            nfts: true,
            xm: true,
            web2: true,
            other: false,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const gcrExtendedRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        // Getting the status properties data
        const repositorySearch = await gcrExtendedRepository.findOneBy({
            publicKey: publicKey,
        })
        const gcrExtendedSearch = repositorySearch.extended
        if (!gcrExtendedSearch) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const gcrExtendedData: GCRExtended = {
            tokens: gcrExtendedSearch.tokens,
            nfts: gcrExtendedSearch.nfts,
            xm: gcrExtendedSearch.xm,
            web2: gcrExtendedSearch.web2,
            other: gcrExtendedSearch.other,
        }
        // Selecting only the requested data
        if (options.tokens) {
            gcrExtendedData.tokens = gcrExtendedSearch.tokens
        }
        if (options.nfts) {
            gcrExtendedData.nfts = gcrExtendedSearch.nfts
        }
        if (options.xm) {
            gcrExtendedData.xm = gcrExtendedSearch.xm
        }
        if (options.web2) {
            gcrExtendedData.web2 = gcrExtendedSearch.web2
        }
        response.response = gcrExtendedData
        return response
    }

    static async getNativeSubnetsTxs(
        subnetId: string,
        options: GetNativeSubnetsTxsOptions = {
            txData: true,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        const db = await Datasource.getInstance()
        const gcrSubnetsTxsRepository = db
            .getDataSource()
            .getRepository(GCRSubnetsTxs)
        // Getting the status subnets txs data
        const gcrSubnetsTxsSearch = await gcrSubnetsTxsRepository.findBy({
            subnet_id: subnetId,
        })
        if (!gcrSubnetsTxsSearch) {
            response.response = "Subnet not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const gcrSubnetsTxsData: GCRSubnetsTxs[] = []
        // Selecting only the requested data
        if (!options.txData) {
            for (const tx of gcrSubnetsTxsSearch) {
                tx.tx_data = null
                gcrSubnetsTxsData.push(tx)
            }
        }
        response.response = gcrSubnetsTxsData
        return response
    }

    // Routines

    // REVIEW Implement the execution of GCREdit objects
    // TODO Add this after the tx is synced in Sync.ts and in the consensus
    // ? Should we add the rollbacks here?
    // NOTE Once this is implemented, we can remove the old methods from gcr.ts and the other methods that overlap with this one
    /**
     * Applies a single GCR edit operation to the blockchain state
     * @param editOperation The GCR edit to apply
     * @param tx The original transaction containing this edit
     * @param rollback Whether the operation is a rollback
     * @param simulate Whether the operation is being simulated (used for pre-consensus simulation)
     * @returns Result indicating success/failure and any error messages
     * @throws May throw database errors during repository operations
     */
    static async apply(
        editOperation: GCREdit,
        tx: Transaction,
        rollback = false, // operations will be reverse in the rollback
        simulate = false, // used to simulate the GCREdit application
    ): Promise<GCRResult> {
        /*if (tx.hash !== editOperation.txhash) {
            return { success: false, message: "Invalid txhash" }
        }*/

        const repositories = await this.getRepositories()

        // NOTE The rollbacks are applied within the single routines based on the isRollback flag
        if (rollback) {
            editOperation.isRollback = true
        }

        // Applying the edit operations
        switch (editOperation.type) {
            case "balance":
                return GCRBalanceRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            case "nonce":
                return GCRNonceRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            case "identity":
                return GCRIdentityRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            case "storageProgram":
                return this.applyStorageProgramEdit(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            case "assign":
            case "subnetsTx":
                // TODO implementations
                console.log(`Assigning GCREdit ${editOperation.type}`)
                return { success: true, message: "Not implemented" }
            default:
                return { success: false, message: "Invalid GCREdit type" }
        }
    }

    /**
     * Apply Storage Program edit to GCR
     * @param editOperation The GCR edit operation for storage program
     * @param repository GCR_Main repository
     * @param simulate Whether to simulate the operation
     * @returns Result of the storage program edit application
     */
    // REVIEW: Storage Program GCR edit application
    private static async applyStorageProgramEdit(
        editOperation: GCREdit,
        repository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { target, context } = editOperation

        if (!context || !context.operation) {
            return {
                success: false,
                message: "Storage program edit missing operation context",
            }
        }

        if (!context.data) {
            return {
                success: false,
                message: "Storage program edit missing data context",
            }
        }

        if (!context.data.variables) {
            return {
                success: false,
                message: "Storage program edit missing data.variables",
            }
        }

        const operation = context.operation as string
        const sender = context.sender as string
        try {
            // REVIEW: Find the storage program account (using 'pubkey' not 'address')
            let account = await repository.findOne({
                where: { pubkey: target },
            })

            // REVIEW: Handle operation-specific account existence requirements
            if (operation === "CREATE") {
                // CREATE requires account to NOT exist
                if (account) {
                    return {
                        success: false,
                        message: `Storage program already exists: ${target}`,
                    }
                }

                // Create new account for CREATE operation
                const initialSize = getDataSize(context.data.variables)
                if (initialSize > STORAGE_LIMITS.MAX_SIZE_BYTES) {
                    return {
                        success: false,
                        message: `Initial data size ${initialSize} bytes exceeds limit of ${STORAGE_LIMITS.MAX_SIZE_BYTES} bytes (128KB)`,
                    }
                }

                account = repository.create({
                    pubkey: target,
                    balance: 0n,
                    nonce: 0,
                    assignedTxs: [],
                    identities: { xm: {}, web2: {}, pqc: {} },
                    points: {
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
                        },
                        lastUpdated: new Date(),
                    },
                    referralInfo: {
                        totalReferrals: 0,
                        referralCode: "",
                        referrals: [],
                    },
                    data: {
                        variables: context.data.variables,
                        metadata: {
                            ...context.data.metadata,
                            size: initialSize,
                            lastModified: context.data.metadata?.lastModified ?? Date.now(),
                        },
                    },
                    flagged: false,
                    flaggedReason: "",
                    reviewed: false,
                })

                if (!simulate) {
                    await repository.save(account)
                    log.info(`[StorageProgram] CREATE: ${target} by ${sender}`)
                }

                return {
                    success: true,
                    message: `Storage program created: ${target}`,
                }
            }

            // For all other operations (WRITE, UPDATE_ACCESS_CONTROL, DELETE), account must exist
            if (!account || !account.data || !account.data.metadata) {
                return {
                    success: false,
                    message: "Storage program does not exist",
                }
            }

            // Handle WRITE operation
            if (operation === "WRITE") {
                // Validate access control
                const accessCheck = validateStorageProgramAccess(
                    "WRITE_STORAGE",
                    sender,
                    account.data,
                )

                if (!accessCheck.success) {
                    return {
                        success: false,
                        message: accessCheck.error || "Access denied",
                    }
                }

                if (!context.data || !context.data.variables) {
                    return {
                        success: false,
                        message: "WRITE operation missing data.variables",
                    }
                }

                // Merge new variables with existing ones
                const mergedVariables = {
                    ...account.data.variables,
                    ...context.data.variables,
                }

                // REVIEW: Validate merged size BEFORE saving to prevent size limit bypass
                const mergedSize = getDataSize(mergedVariables)
                if (mergedSize > STORAGE_LIMITS.MAX_SIZE_BYTES) {
                    return {
                        success: false,
                        message: `Merged data size ${mergedSize} bytes exceeds limit of ${STORAGE_LIMITS.MAX_SIZE_BYTES} bytes (128KB)`,
                    }
                }

                account.data.variables = mergedVariables
                account.data.metadata.lastModified = context.data.metadata?.lastModified || Date.now()
                account.data.metadata.size = mergedSize

                if (!simulate) {
                    await repository.save(account)
                    log.info(`[StorageProgram] WRITE: ${target} by ${sender}`)
                }

                return {
                    success: true,
                    message: `Storage program updated: ${target}`,
                }
            }

            // Handle UPDATE_ACCESS_CONTROL operation
            if (operation === "UPDATE_ACCESS_CONTROL") {
                // Validate deployer-only access
                const accessCheck = validateStorageProgramAccess(
                    "UPDATE_ACCESS_CONTROL",
                    sender,
                    account.data,
                )

                if (!accessCheck.success) {
                    return {
                        success: false,
                        message: accessCheck.error || "Only deployer can update access control",
                    }
                }

                if (!context.data || !context.data.metadata) {
                    return {
                        success: false,
                        message: "UPDATE_ACCESS_CONTROL missing metadata",
                    }
                }

                // Update access control settings
                if (context.data.metadata.accessControl) {
                    account.data.metadata.accessControl = context.data.metadata.accessControl
                }

                if (context.data.metadata.allowedAddresses !== undefined) {
                    account.data.metadata.allowedAddresses = context.data.metadata.allowedAddresses
                }

                account.data.metadata.lastModified = context.data.metadata.lastModified || Date.now()

                if (!simulate) {
                    await repository.save(account)
                    log.info(`[StorageProgram] ACCESS_CONTROL_UPDATE: ${target} by ${sender}`)
                }

                return {
                    success: true,
                    message: `Access control updated for: ${target}`,
                }
            }

            // Handle DELETE operation
            if (operation === "DELETE") {
                // Validate deployer-only access
                const accessCheck = validateStorageProgramAccess(
                    "DELETE_STORAGE_PROGRAM",
                    sender,
                    account.data,
                )

                if (!accessCheck.success) {
                    return {
                        success: false,
                        message: accessCheck.error || "Only deployer can delete storage program",
                    }
                }

                // Clear storage program data
                account.data = {
                    variables: {},
                    metadata: null,
                }

                if (!simulate) {
                    await repository.save(account)
                    log.info(`[StorageProgram] DELETE: ${target} by ${sender}`)
                }

                return {
                    success: true,
                    message: `Storage program deleted: ${target}`,
                }
            }

            return {
                success: false,
                message: `Unknown storage program operation: ${operation}`,
            }
        } catch (error) {
            log.error(`[StorageProgram] Error applying edit: ${error instanceof Error ? `${error.message}
Stack: ${error.stack || "N/A"}` : String(error)}`)
            return {
                success: false,
                message: `Error: ${error instanceof Error ? error.message : String(error)}`,
            }
        }
    }

    /**
     * Applies all GCR edits from a transaction
     * @param tx Transaction containing GCR edits to apply
     * @param isRollback Whether the operation is a rollback
     * @param simulate Whether the operation is being simulated (used for pre-consensus simulation)
     * @returns Combined result of all edit applications
     * @throws May throw if any edit application fails
     */
    static async applyToTx(
        tx: Transaction,
        isRollback = false,
        simulate = false,
    ): Promise<GCRResult> {
        const editsResults: GCRResult[] = []
        const txExists = await Chain.checkTxExists(tx.hash)
        if (txExists) {
            return {
                success: false,
                message: "Transaction already executed",
            }
        }

        console.log(
            "[applyToTx] Starting execution of " +
                tx.content.gcr_edits.length +
                " GCREdits",
        )
        // Keep track of applied edits to be able to rollback them
        const appliedEdits: GCREdit[] = []
        for (const edit of tx.content.gcr_edits) {
            console.log("[applyToTx] Executing GCREdit: " + edit.type)
            try {
                const result = await HandleGCR.apply(
                    edit,
                    tx,
                    isRollback,
                    simulate,
                )
                console.log(
                    "[applyToTx] GCREdit executed: " +
                        edit.type +
                        " with result: " +
                        result.success +
                        " and message: " +
                        result.message,
                )
                // If not successful, we stop the execution
                if (!result.success) {
                    await this.rollback(tx, appliedEdits) // Rollback the applied edits
                    throw new Error(
                        "GCREdit failed for " +
                            edit.type +
                            " with message: " +
                            result.message,
                    )
                }
                editsResults.push(result)
                appliedEdits.push(edit) // Keep track of applied edits
            } catch (e) {
                console.error("Error applying GCREdit: ", e)
                log.error("[applyToTx] Error applying GCREdit: " + e)
                editsResults.push({
                    success: false,
                    message: `${e}`,
                })
                await this.rollback(tx, appliedEdits) // Rollback the applied edits
                // Stopping the execution
                if (!simulate) {
                    break
                }
            }
        }

        if (!editsResults.every(result => result.success)) {
            log.error("[applyToTx] Failed to apply GCREdit")
            const failedMessages = editsResults
                .filter(result => !result.success)
                .map(result => result.message)
                .join(", ")

            return {
                success: false,
                message: failedMessages,
            }
        }

        return { success: true, message: "" }
    }

    /**
     * Rolls back a transaction by reversing the order of applied GCR edits
     * @param tx The transaction to rollback
     * @param appliedEditsOriginal The original list of applied GCR edits
     * @returns Result indicating success/failure and any error messages
     * @throws May throw if any edit rollback fails
     */
    static async rollback(
        tx: Transaction,
        appliedEditsOriginal: GCREdit[],
    ): Promise<GCRResult> {
        // We need to reverse the order of the applied edits
        const appliedEdits = appliedEditsOriginal.reverse()
        log.info(
            "[rollback] Rolling back " +
                appliedEdits.length +
                " GCREdits for tx: " +
                tx.hash,
        )
        // To rollback the edits, we need to pass the rollback flag to the apply method
        const counter = 0
        const results: GCRResult[] = []
        for (const edit of appliedEdits) {
            console.log(
                "[rollback] (" +
                    counter +
                    "/" +
                    appliedEdits.length +
                    ") Rolling back GCREdit: " +
                    edit.type,
            )
            const result = await this.apply(edit, tx, true)
            results.push(result)
        }
        log.info(
            "[rollback] Rolled back " +
                counter +
                " GCREdits for tx: " +
                tx.hash,
        )
        return {
            success: results.every(result => result.success),
            message: results.map(result => result.message).join(", "),
        }
    }

    // ! SECTION GCREdit methods

    // Assign methods // ? Probably to remove

    // TODO We have to port these methods from gcr.ts, now they are just proxies
    assign = {
        xm: assignXM,
        web2: assignWeb2,
        identity: {
            assignFromWrite: IdentityManager.inferIdentityFromWrite,
        },
    }

    // This is a proxy to the manageNative methods for simplicity
    native = manageNative

    // Utilities
    utilities = {
        ensureGCRForUser,
    }

    // State save methods
    save = gcrStateSave

    // Hash methods
    hash = {
        tables: hashGCRTables,
    }

    // JSONB methods
    jsonb = {
        get: GCRJsonbHandler.getJSONBValue,
        update: GCRJsonbHandler.updateJSONBValue,
    }

    private static async getRepositories() {
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()

        return {
            main: dataSource.getRepository(GCRMain),
            hashes: dataSource.getRepository(GCRHashes),
            subnetsTxs: dataSource.getRepository(GCRSubnetsTxs),
            tracker: dataSource.getRepository(GCRTracker),
        }
    }

    // Create methods
    /**
     * Creates a new GCRMain account.
     * If fillData is provided, the account will be created with the provided data.
     *
     * @param pubkey The public key of the account
     * @param fillData Optional data to fill in the account
     * @returns The created GCRMain account
     */
    public static createAccount = async (
        pubkey: string,
        fillData: Record<string, any> = {},
    ) => {
        if (
            !pubkey ||
            typeof pubkey !== "string" ||
            pubkey.trim().length === 0
        ) {
            throw new Error("Invalid public key provided")
        }

        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        const repository = dataSource.getRepository(GCRMain)
        const account = new GCRMain()

        account.pubkey = pubkey
        account.balance = fillData["balance"] || 0n
        account.identities = fillData["identities"] || {
            xm: {},
            web2: {},
            pqc: {},
        }

        account.assignedTxs = []
        account.nonce = fillData["nonce"] || 0
        account.points = fillData["points"] || {
            totalPoints: 0,
            breakdown: {
                web3Wallets: {},
                socialAccounts: {
                    twitter: 0,
                    github: 0,
                    discord: 0,
                },
                referrals: 0,
                demosFollow: 0,
            },
            lastUpdated: new Date(),
        }

        account.referralInfo = fillData["referralInfo"] || {
            totalReferrals: 0,
            referralCode: Referrals.generateReferralCode(pubkey),
            referrals: [],
            referredBy: null,
        }
        account.flagged = fillData["flagged"] || false
        account.flaggedReason = fillData["flaggedReason"] || ""
        account.reviewed = fillData["reviewed"] || false
        account.createdAt = fillData["createdAt"] || new Date()
        account.updatedAt = fillData["updatedAt"] || new Date()

        return await repository.save(account)
    }
}
