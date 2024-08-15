import ServerHandlers from "./endpointHandlers"
import { RPCResponse } from "./server_rpc"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

export type VoteRequest = {
    parameter: string
    timestamp: number
}

// ? REVIEW This has not been tested yet
export async function manageVote(
    request: VoteRequest,
    callback: (response: RPCResponse) => void,
): Promise<RPCResponse> {
    term.yellow("[SERVER] Received vote request\n")
    //console.log(request)
    let voteResponse: RPCResponse
    let res: RPCResponse

    console.log("request")
    //console.log(request)

    switch (request.parameter) {
        case "forgedProposedHash":
            res = await ServerHandlers.handleVoteRequest(request.timestamp)
            voteResponse = res
    }

    callback(voteResponse)

    // ? REVIEW This has not been tested yet too
    return {
        result: 200,
        response: voteResponse,
        require_reply: true,
        extra: {},
    }
}
