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
import { EncryptedTransaction, RPCResponse, Transaction } from "@kynesyslabs/demosdk/types"
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

// REVIEW Trying to use the new GCRv2
import { GCR_Main } from "src/model/entities/GCRv2/GCR_Main"
import { GCR_Tracker } from "src/model/entities/GCRv2/GCR_Tracker"

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

    // ! IMPORTANT
    /** NOTE How the GCR is managed when a transaction is executed
     * Each tx generates an Operation, see handleExecuteTransaction in // LINK src/libs/network/endpointHandlers.ts
     * TODO The Operation es executed in this file
     * At consensus, the pack of operations should be sent/merged and included in the block in // LINK src/libs/consensus/v2/PoRBFT.ts
     * Each time a sync is made, the pack of Operations (the sql queries) are executed in // LINK src/libs/blockchain/routines/Sync.ts
     *
     * ? Try to cleanup the code and remove the old methods from gcr.ts
     */

    // TODO Implement the execution of GCREdit objects
    // ! Add this both after the tx is executed and after the tx is synced in Sync.ts and in the consensus
    // NOTE Once this is implemented, we can remove the old methods from gcr.ts and the other methods that overlap with this one
    static async apply(GCREdit: GCREdit, tx: Transaction): Promise<[boolean, string]> {
        // 1. Check if the GCREdit is valid (check if the txhash is valid) // REVIEW see if this is enough
        if (tx.hash !== GCREdit.txhash) {
            return [false, "Invalid txhash"]
        }
        /**
         * 2. Check if the GCREdit is already applied (check if the txhash is already applied) // ? see how to do this
         * 3. Apply the GCREdit to the GCR using the appropriate method to edit the database
         */
        switch (GCREdit.type) {
            case "balance":
                console.log("Applying GCREdit balance: ", GCREdit.operation, GCREdit.amount, GCREdit.account)
                break
            case "nonce":
                console.log("Applying GCREdit nonce: ", GCREdit.operation, GCREdit.amount, GCREdit.account)
                break
            case "assign":
                console.log("Assigning GCREdit context: ", GCREdit.context, GCREdit.account)
                break
            case "identity":
                console.log("Assigning GCREdit identity: ", GCREdit.identity, GCREdit.account)
                break
            case "subnetsTx":
                console.log("Assigning GCREdit subnetsTx: ", GCREdit.txhash, GCREdit.account)
                break
        }
        // TODO Implement the actual application of the GCREdit above
        return [true, "GCREdit applied"]
    }

    // Assign methods

    

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
}
