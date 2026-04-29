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
import { OmniServerConfig } from "@/libs/omniprotocol/integration/startup"
import { Config } from "src/config"
import {
    APP_VERSION,
    APP_VERSION_NAME,
    DEFAULT_SIGNING_ALGORITHM,
    DEFAULT_BLOCK_TIME,
    PEER_RECHECK_INTERVAL_MS,
    BATCH_SYNC_BLOCK_SIZE,
    BATCH_SYNC_TX_SIZE,
    BATCH_SYNC_TX_LIMIT,
    BATCH_SYNC_BLOCK_LIMIT,
    RATE_LIMIT_DEFAULT_MAX_REQUESTS,
    RATE_LIMIT_DEFAULT_WINDOW_MS,
    RATE_LIMIT_POST_MAX_REQUESTS,
    RATE_LIMIT_POST_WINDOW_MS,
    RATE_LIMIT_TX_PER_BLOCK,
    LOCALHOST_IPS,
    TWITTER_COOKIE_FILE,
} from "./constants"

dotenv.config()

export default class SharedState {
    private static instance: SharedState

    // !SECTION Constants
    prod = Config.getInstance().core.prod
    version = APP_VERSION
    version_name = APP_VERSION_NAME
    signingAlgorithm = DEFAULT_SIGNING_ALGORITHM as SigningAlgorithm

    block_time = DEFAULT_BLOCK_TIME // TODO Get it from the genesis (or see Consensus module)

    currentTimestamp = 0
    currentUTCTime = 0
    lastTimestamp = 0
    lastShardSeed = ""
    referenceBlockRoom = 1
    shardSize = Config.getInstance().core.shardSize
    mainLoopSleepTime = Config.getInstance().core.mainLoopSleepTime

    // NOTE See calibrateTime.ts for this value
    timestampCorrection = 0

    // SECTION shared state variables
    // Modes
    isShuttingDown = false
    isInitialized = false
    inMainLoop = false
    inConsensusLoop = false
    inSyncLoop = false
    inPeerRecheckLoop = false
    lastPeerRecheck = 0
    peerRecheckSleepTime = PEER_RECHECK_INTERVAL_MS
    inPeerGossip = false
    startingConsensus = false
    isSignalingServerStarted = false
    isMCPServerStarted = false
    isOmniProtocolEnabled = true

    omniConfig: OmniServerConfig = {
        enabled: true,
        port: 0, // Will be from indexState during startup
        maxConnections: 1000,
        authTimeout: 5000,
        connectionTimeout: 600000, // 10 minutes
        // TLS configuration
        tls: {
            enabled: Config.getInstance().omni.tls.enabled,
            mode: (Config.getInstance().omni.tls.mode as "self-signed" | "ca") || "self-signed",
            certPath: Config.getInstance().omni.tls.certPath,
            keyPath: Config.getInstance().omni.tls.keyPath,
            caPath: Config.getInstance().omni.tls.caPath,
            minVersion: (Config.getInstance().omni.tls.minVersion as "TLSv1.2" | "TLSv1.3") || "TLSv1.3",
        },
        // Rate limiting configuration
        rateLimit: {
            enabled: Config.getInstance().omni.rateLimit.enabled,
            maxConnectionsPerIP: Config.getInstance().omni.rateLimit.maxConnectionsPerIp,
            maxRequestsPerSecondPerIP: Config.getInstance().omni.rateLimit.maxRequestsPerSecondPerIp || 100,
            maxRequestsPerSecondPerIdentity: Config.getInstance().omni.rateLimit.maxRequestsPerSecondPerIdentity || 200,
            windowMs: 1000,
            entryTTL: 60000,
            cleanupInterval: 10000,
        },
    }

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

    // Batch sync configuration
    batchSyncBlockSize = BATCH_SYNC_BLOCK_SIZE
    batchSyncTxSize = BATCH_SYNC_TX_SIZE
    batchSyncTxLimit = BATCH_SYNC_TX_LIMIT
    batchSyncBlockLimit = BATCH_SYNC_BLOCK_LIMIT

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

    // SECTION L2PS
    l2psJoinedUids: string[] = [] // UIDs of the L2PS networks that are joined to the node (loaded from the data directory)
    l2psBatchNonce = 0 // Persistent nonce for L2PS batch transactions

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
    rpcFee: number = Config.getInstance().core.rpcFeePercent
    networkFee: number = Config.getInstance().core.networkFee

    /**
     * Active network parameters. Loaded once at startup by
     * `loadNetworkParameters()` — either from the latest `active` NetworkUpgrade
     * in the DB, or from GENESIS_NETWORK_PARAMETERS when no upgrade has
     * activated. Re-read at each post-block activation hook.
     *
     * Typed loosely here to avoid a circular import between sharedState and
     * features/networkUpgrade/types.ts.
     */
    networkParameters: unknown = null
    serverPort = Config.getInstance().server.serverPort
    identityFile: string = Config.getInstance().core.identityFile
    peerListFile: string = Config.getInstance().core.peerListFile
    connectionString: string = "http://localhost:" + this.serverPort
    exposedUrl: string = Config.getInstance().core.exposedUrl
    PROD: boolean = Config.getInstance().core.prod
    SUDO_PUBKEY = Config.getInstance().core.sudoPubkey
    // ABSTRACTION
    twitterCookieFile = TWITTER_COOKIE_FILE
    // !SECTION Configuration

    // TODO The following variables should be in the genesis
    maxMessageSize = Config.getInstance().core.maxMessageSize

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
        return Config.getInstance().core.consensusCheckInterval
    }

    /**
     * @returns The block time in seconds
     */
    public getConsensusTime(): number {
        return Config.getInstance().core.consensusTime || this.block_time
    }

    public async getConnectionString(): Promise<string> {
        // Getting our public ip
        return this.exposedUrl
    }

    // SECTION Rate limiting configuration
    rateLimitConfig = {
        enabled: true,
        defaultLimit: { maxRequests: RATE_LIMIT_DEFAULT_MAX_REQUESTS, windowMs: RATE_LIMIT_DEFAULT_WINDOW_MS },
        blockDurationMs: undefined,
        whitelistedIPs: [
            ...LOCALHOST_IPS,
            ...Config.getInstance().core.whitelistedIPs,
        ],
        whitelistedKeys: [
            ...Config.getInstance().core.whitelistedKeys,
        ],
        methodLimits: {
            POST: { maxRequests: RATE_LIMIT_POST_MAX_REQUESTS, windowMs: RATE_LIMIT_POST_WINDOW_MS },
        },
        txPerBlock: RATE_LIMIT_TX_PER_BLOCK,
    }

    // NOTE This is a wrapper for many stats that are used by the node and the rpc server
    public async getInfo(): Promise<any> {
        const peerlist = PeerManager.getInstance().getPeers()

        // change our connection string to the exposed url
        for (const peer of peerlist) {
            if (peer.identity === this.publicKeyHex) {
                peer.connection.string = await this.getConnectionString()
            }
        }

        const info = {
            version: this.version,
            identity: this.publicKeyHex,
            connectionString: await this.getConnectionString(),
            peerlist: peerlist,
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
