import { pki } from "node-forge"
import { Socket } from "socket.io-client"
// INFO This module manages gasless calls (such as rpc calls, consensus, etc.)
import ComLink from "src/libs/communications/comlink"
import { proofConsensusHandler } from "src/libs/consensus/routines/proofOfConsensus"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import { BundleContent } from "@kynesyslabs/demosdk/types"

import ServerHandlers from "../endpointHandlers"
import { RPCResponse } from "../server_rpc"

const term = terminalkit.terminal

export default async function manageMessages(
    content: BundleContent,
    original_comlink: ComLink,
    original_request: any,
    id_ed25519: pki.KeyPair,
): Promise<RPCResponse> {
    
    let result: RPCResponse = {
        result: 500,
        response: "no response yet",
        require_reply: false,
        extra: "",
    }

    switch (content.type) {
        case "proofOfConsensus":
            result = await proofConsensusHandler(content)
            break
        case "consensus":
            console.log("[SERVER LISTENER HANDLER]: received consensus request from: " + 
                original_comlink.chain.current.currentMessage.bundle.content.sender.toString("hex"),
            )
            result = await ServerHandlers.handleConsensusRequest(
                    original_request,
                    content,
                    original_comlink.chain.current.currentMessage.bundle.content
                        .sender,
                )
            break

        case "messages":
            result = await ServerHandlers.handleMessage(content)
            break

        case "storage":
            result = await ServerHandlers.handleStorage()
            break

        case "mempool":
            result = await ServerHandlers.handleMempool(content)
            break

        case "nodeCall":
            result = await ServerHandlers.handleNodeAPI(
                    content,
                    id_ed25519,
                )
            break

        default:
            term.red(`[COMLINK INVALID] No known type: ${content.type}\n`)
            break
    }
    return result
}
