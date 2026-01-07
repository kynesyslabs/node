// INFO This singleton is used to store the state of the application through different parts of the application.

import * as dotenv from "dotenv"
import * as forge from "node-forge"
import Block from "src/libs/blockchain/block"
import chain from "src/libs/blockchain/chain"
import { Identity } from "src/libs/identity"
// eslint-disable-next-line no-unused-vars
import * as ntpClient from "ntp-client"
import { Peer, PeerManager } from "src/libs/peer"
import { SigningAlgorithm, ValidityData } from "@kynesyslabs/demosdk/types"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { PeerOmniAdapter } from "src/libs/omniprotocol/integration/peerAdapter"
import type { MigrationMode } from "src/libs/omniprotocol/types/config"
import log from "@/utilities/logger"
import type { TLSNotaryState } from "@/features/tlsnotary/proxyManager"
import type { TokenStoreState } from "@/features/tlsnotary/tokenManager"

dotenv.config()

export default class SharedState {
    private static instance: SharedState

    // !SECTION Constants
    prod = process.env.PROD == "true" || false
    version = "0.9.5"
    version_name = "Entangled Polymer"
    signingAlgorithm = "ed25519" as SigningAlgorithm

    block_time = 10 // TODO Get it from the genesis (or see Consensus module)

    currentTimestamp = 0
    currentUTCTime = 0
    lastTimestamp = 0
    lastShardSeed = ""
    referenceBlockRoom = 1
    shardSize = parseInt(process.env.SHARD_SIZE) || 2
    mainLoopSleepTime = parseInt(process.env.MAIN_LOOP_SLEEP_TIME) || 1000 // 1 second

    // NOTE See calibrateTime.ts for this value
    timestampCorrection = 0

    // SECTION shared state variables
    // Modes
    inMainLoop = false
    inConsensusLoop = false
    inSyncLoop = false
    inPeerRecheckLoop = false
    lastPeerRecheck = 0 
    peerRecheckSleepTime = 10_000 // 10 seconds
    inPeerGossip = false
    startingConsensus = false
    isSignalingServerStarted = false
    isMCPServerStarted = false
    isOmniProtocolEnabled = true

    // OmniProtocol adapter for peer communication
    private _omniAdapter: PeerOmniAdapter | null = null

    // SECTION TLSNotary Proxy Manager State
    // Stores wstcp proxy processes and port pool for TLS attestation
    tlsnotary: TLSNotaryState | null = null

    // SECTION TLSNotary Token Store
    // In-memory token store for paid attestation access
    tlsnTokenStore: TokenStoreState | null = null

    // Running as a node (is false when running specific modules like the signaling server)
    runningAsNode = true

    // Mempool
    inGetMempool = false
    inCleanMempool = false
    // REVIEW Mempool caching

    // DTR (Distributed Transaction Routing) - ValidityData cache for retry mechanism
    // Stores ValidityData for transactions that need to be relayed to validators
    validityDataCache = new Map<string, ValidityData>() // txHash -> ValidityData

    // States
    runMainLoop = true
    mainLoopPaused = false
    consensusMode = false

    // Sync
    fastSyncCount = 0
    _syncStatus = false
    set syncStatus(synced: boolean) {
        this._syncStatus = synced
        // INFO: Update our peer object when we get a new sync status
        PeerManager.getInstance().updateOurPeerSyncData()

        if (synced) {
            this.fastSyncCount += 1
        }
    }

    get syncStatus(): boolean {
        return this._syncStatus
    }

    peerRoutineRunning = 0
    // SECTION shared state variables
    shard: Peer[]
    // lastShard: string[] // ? Should be used by PoRBFT.ts consensus and should contain all the public keys of the nodes in the last shard
    identity: Identity
    keypair: {
        publicKey:
            | Uint8Array
            | forge.pki.rsa.PublicKey
            | forge.pki.ed25519.NativeBuffer
        privateKey:
            | Uint8Array
            | forge.pki.rsa.PrivateKey
            | forge.pki.ed25519.NativeBuffer
        genKey?: Uint8Array
    }
    get publicKeyHex(): string {
        if (!this.keypair?.publicKey) {
            return null
        }

        if (this.keypair.publicKey instanceof Uint8Array) {
            return uint8ArrayToHex(this.keypair.publicKey)
        }

        throw new Error(
            `Unsupported public key type for hex conversion: ${typeof this
                .keypair.publicKey}`,
        )
    }
    lastConsensusTime = 0

    // SECTION Consensus states
    candidateBlock: Block
    lastBlockNumber = 0
    _lastBlockHash = ""
    genesisIdentities = new Set<string>()

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
    serverPort = 53550
    identityFile: string = process.env.IDENTITY_FILE || ".demos_identity"
    peerListFile: string = process.env.PEER_LIST_FILE || "demos_peerlist.json"
    connectionString: string = "http://localhost:" + this.serverPort
    exposedUrl: string = process.env.EXPOSED_URL || this.connectionString
    PROD: boolean = process.env.PROD == "true" || false // ! debug line, set to true to run in prod
    SUDO_PUBKEY = process.env.SUDO_PUBKEY || null
    // ABSTRACTION
    twitterCookieFile = "twitter_cookies.json"
    // !SECTION Configuration

    // TODO The following variables should be in the genesis
    maxMessageSize = parseInt(process.env.MAX_MESSAGE_SIZE) // TODO Implement // 5 GB just for debug purpose

    constructor() {
        this.identity = Identity.getInstance()
    }

    public static getInstance(): SharedState {
        if (!SharedState.instance) {
            SharedState.instance = new SharedState()
        }
        return SharedState.instance
    }

    // Getter for the current UTC time (optional in ms, default in s integer)
    // It can use NTP or system time based on the ntp parameter, default is system time
    public async getUTCTime(ntp = false, inSeconds = true): Promise<boolean> {
        try {
            if (ntp) {
                this.currentUTCTime = await this.getNTPTime()
            } else {
                this.currentUTCTime = this.getTimestamp(inSeconds)
            }
            return true
        } catch (err) {
            log.error(err)
            this.currentUTCTime = this.getTimestamp(inSeconds)
            return false
        }
    }

    // Getter for the current NTP time
    public async getNTPTime(): Promise<number> {
        const date = await new Promise<Date>((resolve, reject) => {
            ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
                if (err) reject(err)
                else resolve(date)
            })
        })
        const timestamp = date.getTime()
        return timestamp
    }

    // Getter for the current timestamp (optional in ms, default in s integer)
    public getTimestamp(inSeconds = true): number {
        this.currentTimestamp = Date.now() // REVIEW Maybe
        const timestamp = inSeconds
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

    /**
     * @returns The block time in seconds
     */
    public getConsensusTime(): number {
        return Number(process.env.CONSENSUS_TIME) || this.block_time
    }

    public async getConnectionString(): Promise<string> {
        // Getting our public ip
        return this.exposedUrl
    }

    // SECTION Rate limiting configuration
    rateLimitConfig = {
        enabled: true,
        defaultLimit: { maxRequests: 2000, windowMs: 60000 },
        blockDurationMs: undefined,
        // INFO: localhost is always whitelisted
        whitelistedIPs: [
            "127.0.0.1",
            ...(process.env.WHITELISTED_IPS?.split(",").map(ip => ip.trim()) ||
                []),
        ],
        methodLimits: {
            // REVIEW: Do we need this?
            POST: { maxRequests: 200000, windowMs: 86400000 },
            // INFO: POST method limits per IP address
            // "nodeCall": { maxRequests: 200, windowMs: 60000 },
            // "execute": { maxRequests: 1, windowMs: 86400000 },
            // "login_request": { maxRequests: 5, windowMs: 60000 },
            // "auth": { maxRequests: 20, windowMs: 60000 },
            // "ping": { maxRequests: 100, windowMs: 60000 },
            // "info": { maxRequests: 100, windowMs: 60000 },
            // "version": { maxRequests: 200, windowMs: 60000 },
            // "publickey": { maxRequests: 100, windowMs: 60000 },
            // "connectionstring": { maxRequests: 100, windowMs: 60000 },
            // "peerlist": { maxRequests: 50, windowMs: 60000 },
            // "public_logs": { maxRequests: 30, windowMs: 60000 },
            // "diagnostics": { maxRequests: 20, windowMs: 60000 },
            // "genesis": { maxRequests: 100, windowMs: 60000 },
            // "rate_limit_stats": { maxRequests: 50, windowMs: 60000 },
            // "rate_limit_unblock": { maxRequests: 5, windowMs: 60000 },
        },
        txPerBlock: 4,
    }

    // NOTE This is a wrapper for many stats that are used by the node and the rpc server
    public async getInfo(): Promise<any> {
        const info = {
            version: this.version,
            identity: this.publicKeyHex,
            connectionString: await this.getConnectionString(),
            peerlist: PeerManager.getInstance().getPeers(),
        }
        return info
    }

    // SECTION OmniProtocol Integration
    /**
     * Initialize the OmniProtocol adapter with the specified migration mode
     * @param mode Migration mode: HTTP_ONLY, OMNI_PREFERRED, or OMNI_ONLY
     */
    public initOmniProtocol(mode: MigrationMode = "OMNI_PREFERRED"): void {
        if (this._omniAdapter) {
            log.debug("[SharedState] OmniProtocol adapter already initialized")
            return
        }

        this._omniAdapter = new PeerOmniAdapter()
        this._omniAdapter.migrationMode = mode
        this.isOmniProtocolEnabled = true
        log.info(
            `[SharedState] ✅ OmniProtocol adapter initialized with mode: ${mode}`,
        )
    }

    /**
     * Get the OmniProtocol adapter instance
     */
    public get omniAdapter(): PeerOmniAdapter | null {
        return this._omniAdapter
    }

    /**
     * Check if OmniProtocol should be used for a specific peer
     * @param peerIdentity The peer's public key identity
     */
    public shouldUseOmniProtocol(peerIdentity: string): boolean {
        if (!this.isOmniProtocolEnabled || !this._omniAdapter) {
            return false
        }
        return this._omniAdapter.shouldUseOmni(peerIdentity)
    }

    /**
     * Mark a peer as supporting OmniProtocol
     * @param peerIdentity The peer's public key identity
     */
    public markPeerOmniCapable(peerIdentity: string): void {
        if (this._omniAdapter) {
            this._omniAdapter.markOmniPeer(peerIdentity)
        }
    }

    /**
     * Mark a peer as HTTP-only (fallback after OmniProtocol failure)
     * @param peerIdentity The peer's public key identity
     */
    public markPeerHttpOnly(peerIdentity: string): void {
        if (this._omniAdapter) {
            this._omniAdapter.markHttpPeer(peerIdentity)
        }
    }
    // !SECTION OmniProtocol Integration
}

// REVIEW Experimental singleton elegant approach
// Export the getter object
const sharedStateGetter = {
    get getSharedState() {
        return SharedState.getInstance()
    },
}
export const { getSharedState } = sharedStateGetter
