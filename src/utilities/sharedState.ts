// INFO This singleton is used to store the state of the application through different parts of the application.

import * as dotenv from "dotenv"
import Block from "src/libs/blockchain/block"
import chain from "src/libs/blockchain/chain"
import { Identity } from "src/libs/identity"
// eslint-disable-next-line no-unused-vars
import * as ntpClient from "ntp-client"
import { Peer, PeerManager } from "src/libs/peer"
import { MempoolData } from "src/libs/blockchain/mempool"

dotenv.config()

export default class sharedState {
    private static instance: sharedState

    version: string = "0.7.4"
    version_name: string = "Slow Takeover"

    block_time: number = 10 // TODO Get it from the genesis (or see Consensus module)

    currentTimestamp: number = 0
    currentUTCTime: number = 0
    lastTimestamp: number = 0
    lastShardSeed: string = ""

    // NOTE See calibrateTime.ts for this value
    timestampCorrection: number = 0

    // SECTION shared state variables
    // Modes
    inMainLoop: boolean = false
    inConsensusLoop: boolean = false
    inSyncLoop: boolean = false
    inPeerRecheckLoop: boolean = false
    inPeerGossip: boolean = false
    startingConsensus: boolean = false

    // Mempool
    inGetMempool: boolean = false
    inCleanMempool: boolean = false
    // REVIEW Mempool caching
    mempoolCache: MempoolData | null = null

    // States
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false

    // Sync
    _syncStatus: boolean = false
    set syncStatus(value: boolean) {
        this._syncStatus = value
        // INFO: Update our peer object when we get a new sync status
        PeerManager.getInstance().updateOurPeerSyncData()
    }

    get syncStatus(): boolean {
        return this._syncStatus
    }

    peerRoutineRunning: number = 0
    // SECTION shared state variables
    shard: Peer[]
    lastShard: string[] // ? Should be used by PoRBFT.ts consensus and should contain all the public keys of the nodes in the last shard
    currentValidatorSeed: string
    identity: Identity
    lastConsensusTime: number = 0

    // SECTION Consensus states
    candidateBlock: Block
    lastBlockNumber: number = 0
    _lastBlockHash: string = ""

    set lastBlockHash(value: string) {
        this._lastBlockHash = value
        // INFO: Update our peer object when we get a new block
        PeerManager.getInstance().updateOurPeerSyncData()
    }

    get lastBlockHash(): string {
        return this._lastBlockHash
    }

    // SECTION Configuration
    rpcFee: number = parseInt(process.env.RPC_FEE_PERCENT) // TODO Implement // Percentage of the fee to be charged for the rpc
    serverPort: number = 53550
    identityFile: string = process.env.IDENTITY_FILE || ".demos_identity"
    peerListFile: string = process.env.PEER_LIST_FILE || "demos_peerlist.json"
    connectionString: string = "http://localhost:" + this.serverPort
    exposedUrl: string = process.env.EXPOSED_URL || this.connectionString
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

    // Getter for the current UTC time (optional in ms, default in s integer)
    // It can use NTP or system time based on the ntp parameter, default is system time
    public async getUTCTime(
        ntp: boolean = false,
        inSeconds: boolean = true,
    ): Promise<boolean> {
        try {
            if (ntp) {
                this.currentUTCTime = await this.getNTPTime()
            } else {
                this.currentUTCTime = this.getTimestamp(inSeconds)
            }
            return true
        } catch (err) {
            console.error(err)
            this.currentUTCTime = this.getTimestamp(inSeconds)
            return false
        }
    }

    // Getter for the current NTP time
    public async getNTPTime(): Promise<number> {
        let date = await new Promise<Date>((resolve, reject) => {
            ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
                if (err) reject(err)
                else resolve(date)
            })
        })
        let timestamp = date.getTime()
        return timestamp
    }

    // Getter for the current timestamp (optional in ms, default in s integer)
    public getTimestamp(inSeconds: boolean = true): number {
        this.currentTimestamp = Date.now() // REVIEW Maybe
        let timestamp = inSeconds
            ? Math.floor(this.currentTimestamp / 1000)
            : this.currentTimestamp
        return timestamp
    }

    public async getLastConsensusTime(): Promise<number> {
        // Retrieve the last block and get the timestamp of it
        const lastBlock = await chain.getLastBlock()
        this.lastConsensusTime = lastBlock.content.timestamp
        return this.lastConsensusTime
    }

    // ANCHOR Dynamic configurations (customizable in .commons)

    // INFO How many ms for each check of the consensus loop
    public getConsensusCheckStep(): number {
        return Number(process.env.CONSENSUS_CHECK_INTERVAL)
    }

    public getConsensusTime(): number {
        return Number(process.env.CONSENSUS_TIME)
    }

    public async getConnectionString(): Promise<string> {
        // Getting our public ip
        return this.exposedUrl
    }

    // NOTE This is a wrapper for many stats that are used by the node and the rpc server
    public async getInfo(): Promise<any> {
        let info = {
            version: this.version,
            identity: this.identity.ed25519.publicKey.toString("hex"),
            connectionString: await this.getConnectionString(),
            peerlist: PeerManager.getInstance().getPeers(),
        }
        return info
    }
}

// REVIEW Experimental singleton elegant approach
// Export the getter object
const sharedStateGetter = {
    get getSharedState() {
        return sharedState.getInstance()
    },
}
export const { getSharedState } = sharedStateGetter
