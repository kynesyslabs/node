/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as socket_client from "socket.io-client"
import Transmission from "src/libs/communications/transmission"
import { NodeCall } from "src/libs/network/manageNodeCall"
import { RPCResponse } from "@kynesyslabs/demosdk-http/types"
import { Peer } from "src/libs/peer"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

export default class Demos {
    connection: string
    rpc: Peer

    constructor() {
        this.connection = null
    }

    // INFO Connecting to a Demos RPC
    async connect(
        protocol: string = "http",
        server: string = "localhost",
        port: number = 53550,
    ): Promise<boolean> {
        this.connection = protocol + "://" + server + ">" + port + ">placeholder"
        this.rpc = new Peer()
        this.rpc.connection.string = this.connection
        let rpc_response = await this.rpc.connect()
        if (rpc_response) {
            return true
        } else {
            return false
        }
    }


    // NOTE Get the last block number easily
    getLastBlockNumber() {
        this.nodeCall("getLastBlockNumber")
    }

    // NOTE Get the last block hash easily
    getLastBlockHash() {
        this.nodeCall("getLastBlockHash")
    }

    // NOTE Get the peer list
    getPeerList() {
        this.nodeCall("getPeerlist")
    }

    // NOTE Get a block by its number eily
    getBlockByNumber(num: number) {
        console.log("getBlockByNumber: num = " + num)
        this.nodeCall("getBlockByNumber", { blockNumber: num })
    }

    // NOTE Get a block by its hash
    getBlockByHash(hash: string) {
        console.log("getBlockByHash called with hash", hash)
        this.nodeCall("getBlockByHash", { hash: hash })
    }

    // NOTE Get the node mempool if authorized
    getMempool() {
        this.nodeCall("getMempool")
    }

    // INFO NodeCalls use the same structure
    async nodeCall(message: string, args: any = {}): Promise<RPCResponse>{
        
        let node_call: NodeCall = {
            message: message,
            data: args,
            muid: null,
        }
        let rpc_response = await this.rpc.call({
            method: "nodeCall",
            params: [node_call],
        })
        return rpc_response
    }
}

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}
