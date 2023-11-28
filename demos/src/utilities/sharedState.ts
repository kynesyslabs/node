// INFO This singleton is used to store the state of the application through different parts of the application.

import * as forge from "node-forge"
import chain from "src/libs/blockchain/chain"
import { ProofOfRepresentation } from "src/libs/consensus/mechanisms/PoR"
require("dotenv").config({ path: "../../.commons" })
import { Identity } from "src/libs/identity"
// eslint-disable-next-line no-unused-vars
import * as Security from "src/libs/network/securityModule"

export default class sharedState {
    private static instance: sharedState

    currentTimestamp: number = 0
    lastTimestamp: number = 0
    identity: Identity

    // SECTION shared state variables
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false
    syncStatus: boolean = false

    shard: ProofOfRepresentation

    serverPort: number = 53550
    // !SECTION shared state variables

    // TODO The following variables should be in the genesis
    maxMessageSize = 500000000000 // 5 GB just for debug purpose

    // SECTION shared useful variables
    rpcFee: number = 0 // TODO Implement
    publicKey: forge.pki.ed25519.BinaryBuffer // TODO Implement
    privateKey: forge.pki.ed25519.BinaryBuffer // TODO Implement

    // !SECTION shared state variables

    constructor() {}

    public static getInstance(): sharedState {
        if (!sharedState.instance) {
            sharedState.instance = new sharedState()
        }
        return sharedState.instance
    }

    public async getTimePassed(): Promise<number> {
        this.currentTimestamp = new Date().getTime()

        const lastBlock = await chain.getLastBlock()
        console.warn("[SHAREDSTATE]: last block")
        console.warn(lastBlock)
        let lastTimestamp: number
        if (chain.isGenesis(lastBlock as any)) {
            //REVIEW - is this useless? I think so.
            console.log("[SHAREDSTATE]: Genesis block detected")
            //REVIEW: is this different than other blocks?
            lastTimestamp = new Date().getTime() - 69420 * 1000
        } else {
            console.log("blockContent")
            console.log(lastBlock.content)
            console.log(lastBlock.content.timestamp)
            lastTimestamp = lastBlock.content.timestamp
        }

        console.log("LAST TIMESTAMP: " + lastTimestamp)

        let delta = this.currentTimestamp - lastTimestamp
        // lastTimestamp = this.currentTimestamp // REVIEW Done? | This must be the last block timestamp

        console.log("this.lastTimestamp")
        console.log(JSON.stringify(lastBlock))
        console.log(this.lastTimestamp)
        console.log("this.currentTimestamp")
        console.log(this.currentTimestamp)
        console.log("delta")
        console.log(delta)

        return delta
    }

    public getTimestamp(): number {
        this.currentTimestamp = Date.now() // REVIEW Maybe
        return this.currentTimestamp
    }

    // ANCHOR Dynamic configurations (customizable in .commons)

    // INFO How many ms for each check of the consensus loop
    public getConsensusCheckStep(): number {
        return Number(process.env.CONSENSUS_CHECK_INTERVAL)
    }

    public getConsensusTime(): number {
        return Number(process.env.CONSENSUS_TIME)
    }
}
