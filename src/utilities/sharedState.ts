// INFO This singleton is used to store the state of the application through different parts of the application.

import * as dotenv from "dotenv"
import forge from "node-forge"
import chain from "src/libs/blockchain/chain"
import { ProofOfRepresentation } from "src/libs/consensus/mechanisms/PoR"
import { Identity } from "src/libs/identity"
// eslint-disable-next-line no-unused-vars
import * as Security from "src/libs/network/securityModule"

dotenv.config({ path: "../../.commons" })

export default class sharedState {
    private static instance: sharedState

    block_time: number = 10 // TODO Get it from the genesis (or see Consensus module)

    currentTimestamp: number = 0
    lastTimestamp: number = 0

    // SECTION shared state variables
    // Modes
    inMainLoop: boolean = false
    inConsensusLoop: boolean = false
    inSyncLoop: boolean = false
    inPeerRecheckLoop: boolean = false
    // States
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false
    syncStatus: boolean = false
    // SECTION shared state variables
    shard: ProofOfRepresentation
    identity: Identity
    connectionString: string = ""
    // !SECTION shared state variables

    // SECTION Configuration
    rpcFee: number = parseInt(process.env.RPC_FEE_PERCENT) // TODO Implement // Percentage of the fee to be charged for the rpc
    serverPort: number = 53550
    identityFile: string = process.env.IDENTITY_FILE || ".demos_identity"
    PROD: boolean = false
    // !SECTION Configuration

    // TODO The following variables should be in the genesis
    maxMessageSize = parseInt(process.env.MAX_MESSAGE_SIZE) // TODO Implement // 5 GB just for debug purpose

    constructor() {
        this.identity = Identity.getInstance()
    }

    public static getInstance(): sharedState {
        if (!sharedState.instance) {
            sharedState.instance = new sharedState()
        }
        return sharedState.instance
    }

    public async getTimePassed(): Promise<number> {
        this.currentTimestamp = new Date().getTime()

        const lastBlock = await chain.getLastBlock()
        console.warn("[SHAREDSTATE]: getting last block")
        //console.warn(lastBlock)
        let lastTimestamp: number
        if (chain.isGenesis(lastBlock as any)) {
            //REVIEW - is this useless? I think so.
            console.log("[SHAREDSTATE]: Genesis block detected")
            //REVIEW: is this different than other blocks?
            lastTimestamp = new Date().getTime() - 69420 * 1000
        } else {
            //console.log("blockContent")
            //console.log(lastBlock.content)
            lastTimestamp = lastBlock.content.timestamp
        }

        console.log("LAST TIMESTAMP: " + lastTimestamp)

        let delta = this.currentTimestamp - lastTimestamp
        // lastTimestamp = this.currentTimestamp // REVIEW Done? | This must be the last block timestamp

        console.log("this.lastTimestamp: " + this.lastTimestamp)
        console.log("this.currentTimestamp: " + this.currentTimestamp)
        console.log("delta: " + delta.toString())

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
