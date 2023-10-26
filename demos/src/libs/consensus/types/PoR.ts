// INFO This module implements Proof of Representation (PoR)

import Chain from "../../blockchain/chain"
import GLS from "../../blockchain/gls/gls"
import * as forge from "node-forge"
import Hashing from "../../crypto/hashing"
import Peer from "../../peer/peer"
import required from "src/utilities/required"
import * as seedrandom from "seedrandom"

import Mempool from "../../blockchain/mempool"

/* INFO
	This class is very strict about what you can and what you cannot do with it. This is by design to avoid
	errors, malicious behavior, and security risks.
	By instantiating this class, you will just obtain an empty possible PoR instance. The only public
	methods that you can use are:
	- getSeed()
		Which returns or create the seed for the PoR instance and ensures that the seed and the peer list are
		both immutable
	- getPeers()
		Which returns the peer list for the PoR instance
	- selectRepresentativeShard()
		Which operates on the peer list and returns a representative shard for the PoR instance
	
	- NOTE that instance.validators.headers always contains the "fingerprint" of the PoR instance for verification
*/

// INFO This class take ProofOfRepresentation and implements the PoR/QBFT methods needed for it to work correctly
export default class RepresentativeShard {
    static instance: RepresentativeShard = null

    // NOTE This will be filled once PoR is executed
    private shard: ProofOfRepresentation = null

    // Singleton getter
    static getInstance(): RepresentativeShard {
        if (RepresentativeShard.instance == null) {
            RepresentativeShard.instance = new RepresentativeShard()
        }
        return RepresentativeShard.instance
    }

    // INFO We avoid to expose .shard directly so it can't be edited by mistake
    public async getShard(peerList: Peer[]): Promise<ProofOfRepresentation> {
        let shard = this.shard
        if (!shard) {
            return await this.generateShard(peerList)
        }
        return shard
    }

    // INFO Generating the shard if needed
    private async generateShard(peerList): Promise<ProofOfRepresentation> {
        let shard = new ProofOfRepresentation()
        await shard.getSeed(undefined, peerList)
        shard.selectRepresentativeShard()
        this.shard = shard
        return shard
    }

    // TODO Define methods for using the shard
}

interface IValidator {
    connectionURL: string
    publicKey_string: string
    publicKey?: forge.pki.ed25519.BinaryBuffer
}
class ProofOfRepresentation {
    private common_seed: string = null
    private peers: Peer[] // Populated by createSeed
    private validators: { [key: string]: IValidator | {} } = {}
    private onBlock: number = 0
    // Immutable flag to indicate that the PoR instance has been already initialized and cannot be changed anymore
    private immutable: boolean = false

    constructor() {}

    // INFO Creating the immutable common seed for this specific proof of representation session
    private async createSeed(on_block: number, onlinePeers): Promise<string> {
        // this.peers = await GLS.getGLSValidatorsAtBlock() // REVIEW Getting all the possible peers
        this.peers = onlinePeers
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
        let hashedPeers = Hashing.sha256(JSON.stringify(this.peers))
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
        // REVIEW Add the header to the mempool too
        Mempool.addHeaders(this.validators["header"])
        return seed
    }

    // INFO Getting out the current seed
    async getSeed(block_n: number = null, onlinePeers): Promise<string> {
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
    ): Promise<{ [key: string]: IValidator }> {
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
            let validator = {
                connectionURL: selectedPeer.connectionString,
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
        shard: { [key: string]: IValidator },
    ): Promise<boolean> {
        let valid = true
        // TODO Verify that the validator list for a given block is valid
        return valid
    }
}
