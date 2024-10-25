import { emptyResponse } from "./../../network/server_rpc"
import _ from "lodash"
// NOTE This will replace gls.ts methods for calling the native tables
import { StatusSubnetsTxs } from "src/model/entities/StatusSubnetsTxs" // TODO Put this in the sdk when done
import { StatusNative } from "src/model/entities/StatusNative"
import { StatusProperties } from "src/model/entities/StatusProperties"
import { StatusHashes } from "src/model/entities/StatusHashes"
import { EncryptedTransaction, RPCResponse } from "@kynesyslabs/demosdk/types"
import Datasource from "src/model/datasource"

export type GetNativeStatusOptions = {
    balance?: boolean
    nonce?: boolean
    txList?: boolean
    identities?: boolean
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
        address: string,
        options: GetNativeStatusOptions = {
            balance: true,
            nonce: true,
            txList: false,
            identities: true,
        },
    ): Promise<RPCResponse> {
        var response: RPCResponse = _.cloneDeep(emptyResponse)
        // Getting the datasource
        const db = await Datasource.getInstance()
        const statusNativeRepository = db
            .getDataSource()
            .getRepository(StatusNative)
        // Getting the status native data
        const statusNative = await statusNativeRepository.findOneBy({ address })
        if (!statusNative) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        let statusNativeData: StatusNative = {
            address: statusNative.address,
            balance: null,
            nonce: null,
            tx_list: null,
            identities: null,
        }
        // Selecting only the requested data
        if (options.balance) {
            statusNativeData.balance = statusNative.balance
        }
        if (options.nonce) {
            statusNativeData.nonce = statusNative.nonce
        }
        if (options.txList) {
            statusNativeData.tx_list = statusNative.tx_list
        }
        if (options.identities) {
            statusNativeData.identities = statusNative.identities
        }
        response.response = statusNativeData
        return response
    }

    static async getNativeProperties(
        address: string,
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
        const statusPropertiesRepository = db.getDataSource().getRepository(StatusProperties)
        // Getting the status properties data
        const statusProperties = await statusPropertiesRepository.findOneBy({ address })
        if (!statusProperties) {
            response.response = "Address not found"
            response.result = 404
            return response
        }
        // Preparing the response
        let statusPropertiesData: StatusProperties = {
            address: statusProperties.address,
            tokens: null,
            nfts: null,
            xm: null,
            web2: null,
            other: null,
        }
        // Selecting only the requested data
        if (options.tokens) {
            statusPropertiesData.tokens = statusProperties.tokens
        }
        if (options.nfts) {
            statusPropertiesData.nfts = statusProperties.nfts
        }
        if (options.xm) {
            statusPropertiesData.xm = statusProperties.xm
        }
        if (options.web2) {
            statusPropertiesData.web2 = statusProperties.web2
        }
        response.response = statusPropertiesData
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
        const statusSubnetsTxsRepository = db.getDataSource().getRepository(StatusSubnetsTxs)
        // Getting the status subnets txs data
        const statusSubnetsTxs = await statusSubnetsTxsRepository.findBy({ subnet_id: subnetId })
        if (!statusSubnetsTxs) {
            response.response = "Subnet not found"
            response.result = 404
            return response
        }
        // Preparing the response
        let statusSubnetsTxsData: StatusSubnetsTxs[] = []
        // Selecting only the requested data
        if (!options.txData) {
            for (const tx of statusSubnetsTxs) {
                tx.tx_data = null
                statusSubnetsTxsData.push(tx)
            }
        }
        response.response = statusSubnetsTxsData
        return response
    }
}
