// INFO This module manages gasless calls (such as rpc calls, consensus, etc.)
import ComLink from "src/libs/communications/comlink"
import { BundleContent } from "@kynesyslabs/demosdk/types"
import { proofConsensusHandler } from "src/libs/consensus/routines/proofOfConsensus"
import ServerHandlers from "../serverHandlers"
import { pki } from "node-forge"
import { Socket } from "socket.io-client"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"
const term = terminalkit.terminal

export default async function manageMessages(
    content: BundleContent,
    original_comlink: ComLink,
    original_request: any,
    id_ed25519: pki.KeyPair,
    receiver: Socket,
) {
    let extra = null
    let require_reply = false
    let response = null

    switch (content.type) {
        case "proofOfConsensus":
            ({ extra, require_reply, response } =
                await proofConsensusHandler(content))

            break
        case "consensus":
            console.log("[SERVER LISTENER HANDLER]: received consensus request")
            console.log(
                original_comlink.chain.current.currentMessage.bundle.content
                    .sender,
            )
            ;({ extra, require_reply, response } =
                await ServerHandlers.handleConsensusRequest(
                    original_request,
                    content,
                    original_comlink.chain.current.currentMessage.bundle.content
                        .sender,
                ))
            break

        case "messages":
            ({ extra, require_reply, response } =
                await ServerHandlers.handleMessage(content))
            break

        case "storage":
            ({ extra, require_reply, response } =
                await ServerHandlers.handleStorage())
            break

        case "mempool":
            ({ extra, require_reply, response } =
                await ServerHandlers.handleMempool(content))
            break

        case "nodeCall":
            ({ extra, require_reply, response } =
                await ServerHandlers.handleNodeAPI(
                    content,
                    receiver,
                    id_ed25519,
                ))
            break

        default:
            term.red(`[COMLINK INVALID] No known type: ${content.type}\n`)
            break
    }
    return { extra, require_reply, response }
}
