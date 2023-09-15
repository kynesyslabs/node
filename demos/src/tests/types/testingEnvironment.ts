// INFO Import everything

import Block from "src/libs/blockchain/blocks"
import Transaction from "src/libs/blockchain/transaction"
import Mempool from "src/libs/blockchain/mempool"
import GLS from "src/libs/blockchain/gls/gls"
import Chain from "src/libs/blockchain/chain"
import { Identity } from "src/libs/identity"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"

require("dotenv").config()
const term = require("terminal-kit").terminal

// Connectivitiy
import socket from "socket.io"
import io from "socket.io-client"

export default class testingEnvironment {
    private static instance: testingEnvironment = null

    estabilished = false
    connection = null

    modules = {
        types: {
            Block: Block,
            Transaction: Transaction,
            Peer: Peer,
        },
        singletons: {
            Mempool: Mempool,
            GLS: GLS,
            Chain: Chain,
            sharedState: sharedState,
            PeerManager: PeerManager,
        },
        statics: {
            Identity: Identity,
            Cryptography: Cryptography,
            Hashing: Hashing,
        },
    }

    constructor() {}

    static async retrieve(): Promise<testingEnvironment> {
        // Printing configuration
        term.yellow("[DEMOS Infrastructure Testing Environment] Environment loaded\n ")
        term.green(process.env.RPC_URL + "\n")

        if (!testingEnvironment.instance) {
            term.yellow("[DEMOS Infrastructure Testing Environment] Starting...\n")
            testingEnvironment.instance = new testingEnvironment()
        }
        term.green("[DEMOS Infrastructure Testing Environment] Retrieving instance...\n")
        term.yellow("[START OF AVAILABLE MODULES]\n")
        console.log(testingEnvironment.instance.modules)
        console.log("[END OF AVAILABLE MODULES]")
        term.yellow("[CONNECTING TO RPC SERVER]\n")
        console.log(process.env.RPC_URL)
        testingEnvironment.instance.connect()
        // Waiting for the blockchain to be connected
        await testingEnvironment.instance.isConnected()
        return testingEnvironment.instance
    }

    // INFO Connection to the testing environment rpc
    connect() {
        this.connection = io(process.env.RPC_URL, {rejectUnauthorized: false})
        this.connection.on("connect", () => {
            this.estabilished = true
            term.bold.green("[DEMOS Infrastructure Testing Environment] Connection established\n")
        })
        this.connection.on("disconnect", () => {
            term.bold.red("[DEMOS Infrastructure Testing Environment] Connection lost\n")
        })
        this.connection.on("connect_error", () => {
            term.bold.red("[DEMOS Infrastructure Testing Environment] Connection error\n")
            console.log(this.connection)
            term.bold.red("[DEMOS Infrastructure Testing Environment] Connection error\n")
        })
    }

    // INFO 10 seconds timeout to check if the connection is established
    async isConnected(timeout: number = 10): Promise<boolean> {
        while (!this.estabilished && timeout > 0) {
            await sleep(1000)
            timeout -= 1
        }
        if (!this.estabilished) throw new Error("Connection not established")
        term.bold.green("[DEMOS Infrastructure Testing Environment] Connection confirmed\n")
        return this.estabilished
    }
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}