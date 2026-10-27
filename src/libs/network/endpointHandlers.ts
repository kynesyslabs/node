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
import Mempool from "src/libs/blockchain/mempool"
import handleL2PS from "./routines/transactions/handleL2PS"
import handleDemosWorkRequest from "./routines/transactions/demosWork/handleDemosWorkRequest"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import { DemoScript } from "@kynesyslabs/demosdk/types"
import { Peer } from "../peer"
import { emptyResponse } from "./rpcDispatch"

import {
    contributePeerlist,
    getLocalSyncObservations,
} from "src/libs/consensus/v2/routines/peerlistMerge"
import { handleValidateTransaction } from "./endpointValidation"
import { handleExecuteTransaction } from "./endpointExecution"
import { handleConsensusRequest } from "./endpointConsensus"
import { handleL2PSHashUpdate } from "./endpointL2PSHash"

// Bounds the hellos one unauthenticated call can start.
const MAX_ANNOUNCED_PEERS = 200

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

    static async handleMempool(content: any, sender = ""): Promise<any> {
        const envelope =
            Array.isArray(content) &&
            content.length === 1 &&
            content[0] &&
            Array.isArray(content[0].txs)
                ? content[0]
                : null
        const txs: Transaction[] = envelope ? envelope.txs : content

        let response = {
            success: false,
            mempool: [],
        }

        try {
            response = await Mempool.receive(txs)
        } catch (error) {
            log.error("[handleMempool] Error receiving mempool: " + error)
        }

        // The contribution feeds the secretary's merge only, so it is
        // recorded independently of what happens to the transactions.
        if (envelope && sender) {
            contributePeerlist(envelope.blockRef, sender, envelope.peerlist)
        }

        const responsePayload = envelope
            ? {
                  txs: response.mempool,
                  peerlist: getLocalSyncObservations(envelope.blockRef),
              }
            : response.mempool

        const ourId = getSharedState.publicKeyHex
        const ourDate = new Date().toISOString()

        return {
            result: response.success ? 200 : 400,
            response: responsePayload,
            extra:
                (response.success ? "Mempool received" : "Mempool not merged") +
                ` by: ${ourId} at ${ourDate}`,
            requireReply: false,
        }
    }

    /**
     * Unauthenticated discovery: the submitted list contributes addresses of
     * peers we do not know yet, each of which is verified with a hello before
     * it is listed. Nothing else in the list (sync, status, verification) is
     * read.
     */
    static async handlePeerlist(content: unknown): Promise<any> {
        const requireReply = false

        if (!Array.isArray(content)) {
            return {
                extra: { peerlistState: "rejected" },
                requireReply,
                response: false,
            }
        }

        const announced: Peer[] = []
        const seen = new Set<string>()
        for (const entry of content.slice(0, MAX_ANNOUNCED_PEERS)) {
            const identity = entry?.identity
            const url = entry?.connection?.string
            if (
                typeof identity !== "string" ||
                typeof url !== "string" ||
                seen.has(identity)
            ) {
                continue
            }
            seen.add(identity)
            announced.push(new Peer(url, identity))
        }

        PeerManager.getInstance().setPeers(announced)
        return { extra: { peerlistState: "merged" }, requireReply, response: true }
    }
}
