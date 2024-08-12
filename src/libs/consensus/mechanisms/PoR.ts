import seedrandom from "seedrandom"
import Chain from "src/libs/blockchain/chain"
import GLS from "src/libs/blockchain/gls/gls"
import Hashing from "src/libs/crypto/hashing"
import { Peer } from "src/libs/peer"
import required from "src/utilities/required"
import { IValidator } from "./types/IValidator"
import log from "src/utilities/logger"

export class ProofOfRepresentation {
    private common_seed: string = null
    private peers: Peer[] // Populated by createSeed
    private validators: { [key: string]: IValidator | {}; } = {}
    private onBlock: number = 0
    // Immutable flag to indicate that the PoR instance has been already initialized and cannot be changed anymore
    private immutable: boolean = false

    constructor() { }

    // INFO Creating the immutable common seed for this specific proof of representation session
    private async createSeed(on_block: number, onlinePeers: Peer[]): Promise<string> {
        // this.peers = await GLS.getGLSValidatorsAtBlock() // REVIEW Getting all the possible peers
        this.peers = onlinePeers
        // Define hashable peers
        let hashablePeers = onlinePeers.map(peer => peer.connection.string)
        console.log(this.peers)
        console.log("this.peers")
        if (this.immutable) {
            return this.common_seed // NOTE Already initialized? We got the seed!
        }
        this.onBlock = on_block
        // ANCHOR Getting the immutable factors
        let lastBlockHash = await Chain.getLastBlockHash()
        let nextBlockNumber = on_block + 1
        let hashedStakes = await GLS.getGLSHashedStakes()
        let hashedPeers = Hashing.sha256(JSON.stringify(hashablePeers))
        // Combining the two immutable factors to improve unpredictability towards malicious validators
        let combined = lastBlockHash
            .concat(hashedStakes)
            .concat(nextBlockNumber.toString())
            .concat(hashedPeers)
        let seed = Hashing.sha256(combined)
        this.common_seed = seed
        this.validators["header"] = {
            immutableCommonSeed: this.common_seed,
            nextBlockNumber: nextBlockNumber,
            lastBlockHash: lastBlockHash,
            hashedStakes: hashedStakes,
            on_block: on_block,
            combined: combined,
        }
        return seed
    }

    async getSelectedPeers(): Promise<Peer[]> {
        return this.peers
    }

    // INFO Getting out the current seed
    async getSeed(block_n: number = null, onlinePeers: Peer[]): Promise<string> {
        if (!block_n) {
            block_n = Number(await Chain.getLastBlockNumber())
        } // REVIEW Fix sanity check here ^ to catch NaN errors
        return this.createSeed(block_n, onlinePeers)
    }

    async getPeers(): Promise<Peer[]> {
        return this.peers
    }

    // INFO The selection algorithm
    async selectRepresentativeShard(
        block_n: number = null,
    ): Promise<{ [key: string]: IValidator; }> {
        required(this.common_seed, "Common seed is not initialized")
        required(this.peers, "Peers are not initialized")
        if (!block_n) {
            block_n = this.onBlock
        } // REVIEW Fix sanity check here ^ to catch NaN errors

        // For safety reasons we need to enforce the immutable flag
        if (!this.immutable) {
            await this.createSeed(block_n, this.peers) // REVIEW: make sure these are the correct peers
            this.immutable = true
        }
        // Allocating the empty validator list
        let generatedList = {}
        let SHARD_SIZE = 10 // TODO Put in Configuration

        // Getting the base seed
        let baseSeed = await this.getSeed(block_n, this.peers) // REVIEW: make sure these are the correct peers
        for (let i = 0; i < SHARD_SIZE; i++) {
            // Updating the seed so that is identical for all but dynamic for the size of the shard
            let seed = baseSeed.concat(i.toString())
            // Seeding Math.random() with the seed value
            seedrandom.xorwow(seed, { global: true })
            // Getting a decimal value between 0 and 1
            let decimalRandom = Math.random()
            // Getting an integer value between 0 and the number of peers
            let integerRandom = Math.floor(decimalRandom * this.peers.length) // REVIEW Does this make sense?
            let selectedPeer = this.peers[integerRandom]
            console.log(this.peers.length, integerRandom, selectedPeer)
            // Assigning the validator to the list
            console.log(selectedPeer)
            log.info("[PoR] Selected peer: " + selectedPeer.connection.string)
            let validator = {
                connectionURL: selectedPeer.connection.string,
                publicKey_string: selectedPeer.identity.toString("hex"), // REVIEW Is this correct?
                publicKey: selectedPeer.identity,
            }
            generatedList[validator.publicKey_string] = validator // REVIEW Could we use the seed as index?
        }
        // Hashing the list before returning it
        let shardHash = Hashing.sha256(JSON.stringify(generatedList))
        // Adding to the headers
        generatedList["headers"] = this.validators["header"]
        generatedList["headers"]["shardHash"] = shardHash
        // TODO What if we implement some priv/public key stuff based on the seed? Why?
        this.validators = generatedList
        return generatedList
    }

    async verifyRepresentativeShard(
        block_n: number,
        shard: { [key: string]: IValidator; },
    ): Promise<boolean> {
        let valid = true
        // TODO Verify that the validator list for a given block is valid
        return valid
    }
}
