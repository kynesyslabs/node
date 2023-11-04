// INFO This singleton is used to store the state of the application through different parts of the application.

import * as forge from "node-forge"
import chain from "src/libs/blockchain/chain"
import { IValidator, ProofOfRepresentation } from "src/libs/consensus/types/PoR"
require("dotenv").config({ path: "../../.commons" })
import { Identity } from "src/libs/identity"

export default class sharedState {
    private static instance: sharedState

    currentTimestamp: number = 0
    lastTimestamp: number = 0
    identity: Identity

    // SECTION shared state variables
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false

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
        this.currentTimestamp = Date.now()

        const lastBlock = await chain.getLastBlock()
        chain.isGenesis(lastBlock)

        const lastTimestamp = lastBlock.timestamp
        let delta = this.currentTimestamp - lastTimestamp
        // lastTimestamp = this.currentTimestamp // FIXME This must be the last block timestamp

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
