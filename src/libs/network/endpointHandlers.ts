/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { Transaction, L2PSTransaction } from "@kynesyslabs/demosdk/types"
import {
    ExecutionResult,
    ValidityData,
    XMScript,
    ConsensusRequest,
    RPCResponse,
    IWeb2Payload,
} from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import PeerManager from "src/libs/peer/PeerManager"
import Mempool from "src/libs/blockchain/mempool_v2"
import handleL2PS from "./routines/transactions/handleL2PS"
import handleDemosWorkRequest from "./routines/transactions/demosWork/handleDemosWorkRequest"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import { DemoScript } from "@kynesyslabs/demosdk/types"
import { Peer } from "../peer"
import { emptyResponse } from "./rpcDispatch"

import { handleValidateTransaction } from "./endpointValidation"
import { handleExecuteTransaction } from "./endpointExecution"
import { handleConsensusRequest } from "./endpointConsensus"
import { handleL2PSHashUpdate } from "./endpointL2PSHash"

/**
 * ServerHandlers facade — delegates to focused sub-modules:
 *   endpointValidation.ts  — tx validation + GCR checks
 *   endpointExecution.ts   — tx execution + mempool/DTR
 *   endpointConsensus.ts   — consensus request handling
 *   endpointL2PSHash.ts    — L2PS hash update handling
 */
export default class ServerHandlers {
    // ── Delegated to sub-modules ──────────────────────────────
    static async handleValidateTransaction(
        tx: Transaction,
        sender: string,
    ): Promise<ValidityData> {
        return handleValidateTransaction(tx, sender)
    }

    static async handleExecuteTransaction(
        validatedData: ValidityData,
        sender: string,
    ): Promise<ExecutionResult> {
        return handleExecuteTransaction(validatedData, sender)
    }

    static async handleConsensusRequest(
        request: ConsensusRequest,
    ): Promise<RPCResponse> {
        return handleConsensusRequest(request)
    }

    static async handleL2PSHashUpdate(tx: Transaction): Promise<RPCResponse> {
        return handleL2PSHashUpdate(tx)
    }

    // ── Simple proxy methods ──────────────────────────────────
    static async handleWeb2Request(
        rawPayload: IWeb2Payload,
    ): Promise<RPCResponse> {
        const params = parseWeb2ProxyRequest(rawPayload)
        return await handleWeb2ProxyRequest(params)
    }

    static async handleXMChainOperation(xmscript: XMScript) {
        log.debug("[XMChain] Handling XM Chain Operation...")
        return await multichainDispatcher.digest(xmscript)
    }

    static async handleXMChainSignedPayload(content: any): Promise<any> {
        // TODO Probably to take out
    }

    static async handleDemosWorkRequest(content: DemoScript) {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        response = await handleDemosWorkRequest(content)
        return response
    }

    static async handleSubnetTx(content: L2PSTransaction) {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        response = await handleL2PS(content)
        return response
    }

    static async handleL2PS(content: any): Promise<RPCResponse> {
        return await handleL2PS(content)
    }

    static async handleMessage(content: any): Promise<any> {
        let extra: any
        const requireReply = false
        const response = "Not Yet Implemented"
        return { extra, requireReply, response }
    }

    static async handleStorage(): Promise<any> {
        const extra = { storageState: "mocked" }
        const requireReply = true
        const response = {}
        return { extra, requireReply, response }
    }

    static async handleMempool(txs: Transaction[]): Promise<any> {
        let response = {
            success: false,
            mempool: [],
        }

        try {
            response = await Mempool.receive(txs)
        } catch (error) {
            log.error("[handleMempool] Error receiving mempool: " + error)
        }

        const ourId = getSharedState.publicKeyHex
        const ourDate = new Date().toISOString()

        return {
            result: response.success ? 200 : 400,
            response: response.mempool,
            extra:
                (response.success ? "Mempool received" : "Mempool not merged") +
                ` by: ${ourId} at ${ourDate}`,
            requireReply: false,
        }
    }

    static async handlePeerlist(content: Peer[]): Promise<any> {
        const ourPeerList = PeerManager.getInstance().getPeers()
        const mergedPeerList: Peer[] = []
        for (const peer of content) {
            if (!mergedPeerList.includes(peer)) {
                mergedPeerList.push(peer)
            }
        }
        const orderedPeerList = mergedPeerList.sort((a, b) =>
            a.identity.localeCompare(b.identity),
        )
        PeerManager.getInstance().setPeers(orderedPeerList, true)
        const extra = { peerlistState: "merged" }
        const requireReply = false
        const response = true
        return { extra, requireReply, response }
    }
}
