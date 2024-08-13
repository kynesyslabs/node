import Transaction from "src/libs/blockchain/transaction"
import { comlinkUtils } from "src/libs/communications"
import ComLink from "src/libs/communications/comlink"
import { cryptography } from "src/libs/crypto"
import manageMessages from "src/libs/network/routines/manageMessages"
import { ISession } from "src/libs/network/routines/sessionManager"
import * as Security from "src/libs/network/securityModule"
import forge from "node-forge"
/* eslint-disable no-extra-semi */
import ServerHandlers from "src/libs/network/serverHandlers"
import { demostdlib } from "src/libs/utils"
import sharedState from "src/utilities/sharedState"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"
import log from "src/utilities/logger"

import {
    BundleContent,
    ISecurityReport,
    ValidityData,
} from "@kynesyslabs/demosdk/types"
import Peer from "src/libs/peer/Peer"
import { PeerManager } from "src/libs/peer"
import Client from "./client"
import { Socket } from "socket.io-client"
import ComLinkUtils from "../communications/comlinkUtils"

let term = terminalkit.terminal

export interface BrowserRequest {
    message: string
    data: any
}

export default class ServerListeners {
    peer: Peer

    constructor(peer: Peer) {
        this.peer = peer
    }

    async runListeners() {
        await this.browserRequestListener()
    }

    // NOTE Browser requests follows a completely different path from the others
    // INFO this set of listeners does not require authentication and
    // are not comlink as well, so they need to have their own listeners
    async browserRequestListener() {
        this.peer.connection.socket.on("browser_request", async request => {
            term.yellow("[SERVER] Received browser request\n")
            // NOTE request MUST be a string conforming to BrowserRequest interface
            let req: BrowserRequest = JSON.parse(request)
            let browserResponse: [boolean, any]
            let res: ISession | (string | boolean)[]
            switch (req.message) {
                case "login_request":
                    res = await ServerHandlers.handleLoginRequest(req)
                    browserResponse = [true, res]
                    break
                case "login_response":
                    res = await ServerHandlers.handleLoginResponse(req)
                    browserResponse = [true, res]
                    break
                case "logout_request":
                    break
                default:
                    browserResponse = [false, "Invalid request"]
                    break
            }
            this.peer.connection.socket.emit(
                "browser_response",
                JSON.stringify(browserResponse),
            )
        })
    }


    authAskEmit = async () => { // ! This should be obsoleted now that we use RPC
        await this.peer.connection.socket.emit("auth_ask", "sign this")
    }


    
}
