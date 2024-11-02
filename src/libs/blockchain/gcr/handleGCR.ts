// ! Unify this and gcr.ts methods

import { emptyResponse } from "./../../network/server_rpc"
import _ from "lodash"
// NOTE This will replace gcr.ts methods for calling the native tables
import { GCRSubnetsTxs } from "src/model/entities/GCR/GCRSubnetsTxs" // TODO Put this in the sdk when done
import { GCRHashes } from "src/model/entities/GCR/GCRHashes"
import { EncryptedTransaction, RPCResponse } from "@kynesyslabs/demosdk/types"
import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"

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
}
