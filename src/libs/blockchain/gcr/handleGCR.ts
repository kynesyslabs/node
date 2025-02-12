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
import {
    EncryptedTransaction,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import hashGCRTables from "./gcr_routines/hashGCR"
import * as GCRJsonbHandler from "./gcr_routines/gcrJSONBHandler"
import ensureGCRForUser from "./gcr_routines/ensureGCRForUser"
import gcrStateSave from "./gcr_routines/gcrStateSaverHelper"
import { assignXM } from "./gcr_routines/assignXM"
import { assignWeb2 } from "./gcr_routines/assignWeb2"
import { txToGCROperation } from "./gcr_routines/txToGCROperation"
import IdentityManager from "./gcr_routines/identityManager"
import manageNative from "./gcr_routines/manageNative"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"

// REVIEW Trying to use the new GCRv2
import { GCR_Main } from "src/model/entities/GCRv2/GCR_Main"
import { GCR_Tracker } from "src/model/entities/GCRv2/GCR_Tracker"
import GCRBalanceRoutines from "./gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "./gcr_routines/GCRNonceRoutines"
import { HandleNativeOperations } from "./gcr_routines/handleNativeOperations"
import GCR from "./gcr"
import sharedState, { getSharedState } from "@/utilities/sharedState"

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

export type GCRResult = {
    success: boolean
    message: string
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
        var response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const GlobalChangeRegistryRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        // Getting the status native data
        const GlobalChangeRegistrySearch =
            await GlobalChangeRegistryRepository.findOneBy({
                publicKey: publicKey,
            })
        if (!GlobalChangeRegistrySearch) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        let GlobalChangeRegistryData: GlobalChangeRegistry = {
            id: GlobalChangeRegistrySearch.id,
            publicKey: GlobalChangeRegistrySearch.publicKey,
            details: GlobalChangeRegistrySearch.details,
            extended: GlobalChangeRegistrySearch.extended,
        }
        // Selecting only the requested data
        if (options.balance) {
            GlobalChangeRegistryData.details.content.balance =
                GlobalChangeRegistrySearch.details.content.balance
        }
        if (options.nonce) {
            GlobalChangeRegistryData.details.content.nonce =
                GlobalChangeRegistrySearch.details.content.nonce
        }
        if (options.txList) {
            GlobalChangeRegistryData.details.content.txs =
                GlobalChangeRegistrySearch.details.content.txs
        }
        if (options.identities) {
            GlobalChangeRegistryData.details.content.identities =
                GlobalChangeRegistrySearch.details.content.identities
        }
        if (options.extended) {
            GlobalChangeRegistryData.extended =
                GlobalChangeRegistrySearch.extended
        }
        response.response = GlobalChangeRegistryData
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
        var response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const GCRExtendedRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        // Getting the status properties data
        const RepositorySearch = await GCRExtendedRepository.findOneBy({
            publicKey: publicKey,
        })
        const GCRExtendedSearch = RepositorySearch.extended
        if (!GCRExtendedSearch) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        let GCRExtendedData: GCRExtended = {
            tokens: GCRExtendedSearch.tokens,
            nfts: GCRExtendedSearch.nfts,
            xm: GCRExtendedSearch.xm,
            web2: GCRExtendedSearch.web2,
            other: GCRExtendedSearch.other,
        }
        // Selecting only the requested data
        if (options.tokens) {
            GCRExtendedData.tokens = GCRExtendedSearch.tokens
        }
        if (options.nfts) {
            GCRExtendedData.nfts = GCRExtendedSearch.nfts
        }
        if (options.xm) {
            GCRExtendedData.xm = GCRExtendedSearch.xm
        }
        if (options.web2) {
            GCRExtendedData.web2 = GCRExtendedSearch.web2
        }
        response.response = GCRExtendedData
        return response
    }

    static async getNativeSubnetsTxs(
        subnetId: string,
        options: GetNativeSubnetsTxsOptions = {
            txData: true,
        },
    ): Promise<RPCResponse> {
        var response: RPCResponse = _.cloneDeep(emptyResponse)
        const db = await Datasource.getInstance()
        const GCRSubnetsTxsRepository = db
            .getDataSource()
            .getRepository(GCRSubnetsTxs)
        // Getting the status subnets txs data
        const GCRSubnetsTxsSearch = await GCRSubnetsTxsRepository.findBy({
            subnet_id: subnetId,
        })
        if (!GCRSubnetsTxsSearch) {
            response.response = "Subnet not found"
            response.result = 404
            return response
        }
        // Preparing the response
        let GCRSubnetsTxsData: GCRSubnetsTxs[] = []
        // Selecting only the requested data
        if (!options.txData) {
            for (const tx of GCRSubnetsTxsSearch) {
                tx.tx_data = null
                GCRSubnetsTxsData.push(tx)
            }
        }
        response.response = GCRSubnetsTxsData
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
        rollback: boolean = false, // operations will be reverse in the rollback
        simulate: boolean = false, // used to simulate the GCREdit application
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
                    repositories.main,
                    simulate,
                )
            case "nonce":
                return GCRNonceRoutines.apply(
                    editOperation,
                    repositories.main,
                    simulate,
                )
            case "assign":
            case "identity":
            case "subnetsTx":
                // TODO implementations
                console.log(`Assigning GCREdit ${editOperation.type}`)
                return { success: false, message: "Not implemented" }
            default:
                return { success: false, message: "Invalid GCREdit type" }
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
        isRollback: boolean = false,
        simulate: boolean = false,
    ): Promise<GCRResult> {
        const editsResults: GCRResult[] = []

        console.log(
            "[applyToTx] Starting execution of " +
                tx.content.gcr_edits.length +
                " GCREdits",
        )
        for (let edit of tx.content.gcr_edits) {
            console.log("[applyToTx] Executing GCREdit: " + edit.type)
            try {
                let result = await HandleGCR.apply(
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
                    throw new Error(
                        "GCREdit failed for " +
                            edit.type +
                            " with message: " +
                            result.message,
                    )
                }
                editsResults.push(result)
                // Stopping the execution
                if (!simulate) {
                    break
                }
            } catch (e) {
                console.error("Error applying GCREdit: ", e)
                log.error("[applyToTx] Error applying GCREdit: " + e)
                editsResults.push({
                    success: false,
                    message: "Error applying GCREdit: " + e,
                })
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
                message: `Failed to apply GCREdit: ${failedMessages}`,
            }
        }

        return { success: true, message: "" }
    }

    // ! SECTION GCREdit methods

    // Assign methods // ? Probably to remove

    // TODO We have to port these methods from gcr.ts, now they are just proxies
    assign = {
        xm: assignXM,
        web2: assignWeb2,
        identity: {
            assignFromWrite: IdentityManager.inferIdentityFromWrite,
            assignFromSignature: IdentityManager.inferIdentityFromSignature,
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
            main: dataSource.getRepository(GCR_Main),
            hashes: dataSource.getRepository(GCRHashes),
            subnetsTxs: dataSource.getRepository(GCRSubnetsTxs),
            tracker: dataSource.getRepository(GCR_Tracker),
        }
    }

    // Create methods
    public static createAccount = async (pubkey: string) => {
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        const repository = dataSource.getRepository(GCR_Main)
        const account = new GCR_Main()
        account.pubkey = pubkey
        account.balance = 0n
        account.identities = {
            xm: new Map(),
            web2: new Map(),
        }
        account.assignedTxs = []
        account.nonce = 0
        return await repository.save(account)
    }
}
