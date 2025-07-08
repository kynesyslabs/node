import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import Chain from "../blockchain/chain"
import GCR from "../blockchain/gcr/gcr"
import eggs from "./routines/eggs"
import { getSharedState } from "src/utilities/sharedState"
import _ from "lodash"
// Importing methods themselves
import getPeerInfo from "./routines/nodecalls/getPeerInfo"
import getPeerlist from "./routines/nodecalls/getPeerlist"
import getPreviousHashFromBlockNumber from "./routines/nodecalls/getPreviousHashFromBlockNumber"
import getPreviousHashFromBlockHash from "./routines/nodecalls/getPreviousHashFromBlockHash"
import getBlockHeaderByNumber from "./routines/nodecalls/getBlockHeaderByNumber"
import getBlockHeaderByHash from "./routines/nodecalls/getBlockHeaderByHash"
import getBlockByNumber from "./routines/nodecalls/getBlockByNumber"
import getBlockByHash from "./routines/nodecalls/getBlockByHash"
import getBlocks from "./routines/nodecalls/getBlocks"
import getTransactions from "./routines/nodecalls/getTransactions"
import Hashing from "../crypto/hashing"
import log from "src/utilities/logger"
import HandleGCR from "../blockchain/gcr/handleGCR"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import isValidatorForNextBlock from "../consensus/v2/routines/isValidator"
import TxUtils from "../blockchain/transaction"
import Mempool from "../blockchain/mempool_v2"
import { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { Twitter } from "../identity/tools/twitter"
import { Tweet } from "@kynesyslabs/demosdk/types"

export interface NodeCall {
    message: string
    data: any
    muid: string
}

// REVIEW Is this module too big?
export async function manageNodeCall(content: NodeCall): Promise<RPCResponse> {
    // Basic Node API handling logic
    // ...
    let result: any // Storage for the result
    let nStat: any // Storage for the native status
    const { data } = content
    let response = _.cloneDeep(emptyResponse)
    response.result = 200 // Until proven otherwise
    response.require_reply = false // Until proven otherwise
    response.extra = null // Until proven otherwise
    //console.log(typeof data)
    console.log(JSON.stringify(content))
    switch (content.message) {
        case "getPeerInfo":
            response.response = await getPeerInfo()
            break
        case "getPeerlist":
            response.response = await getPeerlist()
            break
        case "getPeerlistHash":
            var peerlist = await getPeerlist()
            response.response = Hashing.sha256(JSON.stringify(peerlist))
            log.custom(
                "manageNodeCall",
                "Peerlist hash: " + response.response,
                true,
            )
            break
        // REVIEW Both below for getting the last hash (untested yet)
        case "getPreviousHashFromBlockNumber":
            result = await getPreviousHashFromBlockNumber(data)
            response.response = result.response
            response.extra = result.extra
            break
        case "getPreviousHashFromBlockHash":
            result = await getPreviousHashFromBlockHash(data)
            response.response = result.response
            response.extra = result.extra
            break
        // REVIEW (untested) Headers instead of full blocks
        case "getBlockHeaderByNumber":
            result = await getBlockHeaderByNumber(data)
            response.response = result.response
            response.extra = result.extra
            break
        case "getBlockHeaderByHash":
            result = await getBlockHeaderByHash(data)
            response.response = result.response
            response.extra = result.extra
            break
        case "getLastBlockNumber":
            console.log("[SERVER] Received getLastBlockNumber")
            response.response = await Chain.getLastBlockNumber()
            console.log("[CHAIN.ts] Received reply from the database") // REVIEW Debug
            //console.log(response)
            break
        case "getLastBlock":
            response.response = await Chain.getLastBlock()
            break
        case "getLastBlockHash":
            response.response = await Chain.getLastBlockHash()
            break
        case "getBlockByNumber":
            console.log(`get block by number ${data.blockNumber}`)
            return await getBlockByNumber(data)
        case "getBlocks":
            return await getBlocks(data)
        case "getTransactions":
            return await getTransactions(data)
        case "getBlockByHash":
            // Check if we have .hash or .blockHash
            if (data.hash) {
                console.log(`get block by hash ${data.hash}`)
            } else if (data.blockHash) {
                console.log(`get block by hash ${data.blockHash}`)
                data.hash = data.blockHash
            } else {
                response.result = 400
                response.response = "No hash or blockHash specified"
            }
            try {
                result = await getBlockByHash(data)
                response.response = result.response
                response.extra = result.extra
            } catch (e) {
                response.response = null
                response.result = 400
                response.extra = e
            }
            break
        case "getTxByHash":
            if (!data.hash) {
                response.result = 400
                response.response = "No hash specified"
                break
            }
            console.log(`getting tx with hash ${data.hash}`)
            try {
                response.response = await Chain.getTxByHash(data.hash)
            } catch (e) {
                response.response = null
                response.result = 400
                response.extra = e
            }
            if (!response.response) {
                response.result = 400
                response.response = "error"
            }
            break
        case "getMempool":
            response.response = await Chain.getPendingPool()
            break
        // INFO Authentication listener
        case "getPeerIdentity":
            // NOTE We don't need to sign anything as the headers are signed already
            response.response = getSharedState.keypair.publicKey as Uint8Array // REVIEW Check if this is correct
            //console.log(response)
            break

        // INFO Address info endpoint
        case "getAddressInfo":
            if (!data.address) {
                response.result = 400
                response.response = "No address specified"
                break
            }
            try {
                nStat = (await GCR.getGCRNativeStatus(data.address)) as GCRMain
                response.response = nStat
            } catch (error) {
                response.result = 400
                response.response = "error"
                response.extra = error
            }
            break
        case "getAddressNonce":
            if (!data.address) {
                response.result = 400
                response.response = "No address specified"
                break
            }
            nStat = (await GCR.getGCRNativeStatus(data.address)) as GCRMain
            response.response = nStat.nonce
            break
        case "getPeerTime":
            response.response = new Date().getTime()
            break

        case "getAllTxs":
            var responseObject = await Chain.getAllTxs()
            response.response = responseObject
            break

        // REVIEW Implement native tables requests
        // NOTE: ...(data.options ? [data.options] : []) is used to handle optional parameters. If the options are not provided, the function will use its default values.
        case "getNativeStatus":
            response = await HandleGCR.getNativeStatus(
                data.address,
                ...(data.options ? [data.options] : []),
            )
            break
        case "getNativeProperties":
            response = await HandleGCR.getNativeProperties(
                data.address,
                ...(data.options ? [data.options] : []),
            )
            break
        case "getNativeSubnetsTxs":
            response = await HandleGCR.getNativeSubnetsTxs(
                data.subnetId,
                ...(data.options ? [data.options] : []),
            )
            break

        case "getTweet": {
            if (!data.tweetUrl) {
                response.result = 400
                response.response = "No tweet URL specified"
                break
            }

            const twitter = Twitter.getInstance()
            let tweet: Tweet = null

            try {
                tweet = await twitter.getTweetByUrl(data.tweetUrl)
            } catch (error) {
                response.result = 400
                response.response = {
                    success: false,
                    error: "Failed to get tweet",
                }
                break
            }

            response.result = tweet ? 200 : 400
            if (tweet) {
                const data = {
                    id: tweet.id,
                    created_at: tweet.created_at,
                    text: tweet.text,
                    username: tweet.author.screen_name,
                    userId: tweet.author.rest_id,
                }
                response.response = {
                    tweet: data,
                    success: true,
                }
            } else {
                response.response = {
                    success: false,
                    error: "Failed to get tweet",
                }
            }
            break
        }

        // NOTE Don't look past here, go away
        // INFO For real, nothing here to be seen
        case "hots":
            console.log("[SERVER] Received hots")
            response.response = eggs.hots()
            break
        // REVIEW DTR: Handle relayed transactions from non-validator nodes
        case "RELAY_TX":
            console.log("[DTR] Received relayed transaction")
            try {
                // Verify we are actually a validator for next block
                const isValidator = await isValidatorForNextBlock()
                if (!isValidator) {
                    console.log("[DTR] Rejecting relay: not a validator")
                    response.result = 403
                    response.response = "Node is not a validator for next block"
                    break
                }

                const relayData = data as { transaction: Transaction; validityData: ValidityData }
                const { transaction, validityData } = relayData

                // Validate transaction coherence (hash matches content)
                const isCoherent = TxUtils.isCoherent(transaction)
                if (!isCoherent) {
                    log.error("[DTR] Transaction coherence validation failed: " + transaction.hash)
                    response.result = 400
                    response.response = "Transaction coherence validation failed"
                    break
                }

                // Validate transaction signature
                const signatureValid = TxUtils.validateSignature(transaction)
                if (!signatureValid) {
                    log.error("[DTR] Transaction signature validation failed: " + transaction.hash)
                    response.result = 400
                    response.response = "Transaction signature validation failed"
                    break
                }

                // Add validated transaction to mempool
                const { confirmationBlock, error } = await Mempool.addTransaction({
                    ...transaction,
                    reference_block: validityData.data.reference_block,
                })

                if (error) {
                    response.result = 500
                    response.response = "Failed to add relayed transaction to mempool"
                    log.error("[DTR] Failed to add relayed transaction to mempool: " + error)
                } else {
                    response.result = 200
                    response.response = { message: "Relayed transaction accepted", confirmationBlock }
                    console.log("[DTR] Successfully added relayed transaction to mempool: " + transaction.hash)
                }
            } catch (error) {
                log.error("[DTR] Error processing relayed transaction: " + error)
                response.result = 500
                response.response = "Internal error processing relayed transaction"
            }
            break

        // REVIEW L2PS: Node-to-node communication for L2PS mempool synchronization
        case "getL2PSParticipationById":
            console.log("[L2PS] Received L2PS participation query")
            if (!data.l2psUid) {
                response.result = 400
                response.response = "No L2PS UID specified"
                break
            }
            try {
                // Check if this node participates in the specified L2PS network
                const joinedUIDs = getSharedState.l2psJoinedUids || []
                const isParticipating = joinedUIDs.includes(data.l2psUid)
                
                response.result = 200
                response.response = {
                    participating: isParticipating,
                    l2psUid: data.l2psUid,
                    nodeIdentity: getSharedState.publicKeyHex
                }
                
                log.debug(`[L2PS] Participation query for ${data.l2psUid}: ${isParticipating}`)
            } catch (error) {
                log.error("[L2PS] Error checking L2PS participation: " + error)
                response.result = 500
                response.response = "Internal error checking L2PS participation"
            }
            break

        case "getL2PSMempoolInfo":
            console.log("[L2PS] Received L2PS mempool info request")
            if (!data.l2psUid) {
                response.result = 400
                response.response = "No L2PS UID specified"
                break
            }
            response.result = 501
            response.response = "UNIMPLEMENTED - L2PS mempool info endpoint"
            break

        case "getL2PSTransactions":
            console.log("[L2PS] Received L2PS transactions sync request")
            if (!data.l2psUid) {
                response.result = 400
                response.response = "No L2PS UID specified"
                break
            }
            response.result = 501
            response.response = "UNIMPLEMENTED - L2PS transactions sync endpoint"
            break
        default:
            console.log("[SERVER] Received unknown message")
            // eslint-disable-next-line quotes
            response.response = '{ error: "Unknown message"}'
            break
    }

    // REVIEW Is this ok? Follow back and see
    return response
}
