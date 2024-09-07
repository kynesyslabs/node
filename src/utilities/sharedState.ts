// INFO This singleton is used to store the state of the application through different parts of the application.

import Block from "src/libs/blockchain/block"
import * as dotenv from "dotenv"
import forge from "node-forge"
import chain from "src/libs/blockchain/chain"
import { Identity } from "src/libs/identity"
// eslint-disable-next-line no-unused-vars
import * as Security from "src/libs/network/securityModule"
import axios from "axios"
import * as ntpClient from "ntp-client"
import Chain from "src/libs/blockchain/chain"
import { Peer } from "src/libs/peer"

dotenv.config({ path: "../../.commons" })

export default class sharedState {
    private static instance: sharedState

    block_time: number = 10 // TODO Get it from the genesis (or see Consensus module)

    currentTimestamp: number = 0
    currentUTCTime: number = 0
    lastTimestamp: number = 0

    // SECTION shared state variables
    // Modes
    inMainLoop: boolean = false
    inConsensusLoop: boolean = false
    inSyncLoop: boolean = false
    inPeerRecheckLoop: boolean = false
    startingConsensus: boolean = false
    // States
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false
    syncStatus: boolean = false
    peerRoutineRunning: number = 0
    // SECTION shared state variables
    shard: Peer[]
    lastShard: string[] // ? Should be used by PoRBFT.ts consensus and should contain all the public keys of the nodes in the last shard
    currentValidatorSeed: string
    identity: Identity
    connectionString: string = ""
    lastConsensusTime: number = 0
    // SECTION Consensus states
    candidateBlock: Block


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

    // If this works, use it for the timestamp of the blocks (avg timestamp, consensus time...)
    public async getUTCTime(): Promise<boolean> {
        try {
            const date = await new Promise<Date>((resolve, reject) => {
                ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
                    if (err) reject(err)
                    else resolve(date)
                })
            })
            
            // Convert date to Unix timestamp
            this.currentUTCTime = date.getTime()
            return true
        } catch (err) {
            console.error(err)
            this.currentUTCTime = Date.now()
            return false
        }
    }

    public async getLastConsensusTime(): Promise<number> {
        // Retrieve the last block and get the timestamp of it
        const lastBlock = await chain.getLastBlock()
        this.lastConsensusTime = lastBlock.content.timestamp
        return this.lastConsensusTime
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
