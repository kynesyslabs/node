// INFO This module implements Proof of Representation (PoR)

import Chain from "../blockchain/chain"
import GLS from "../blockchain/gls/gls"
import * as forge from "node-forge"
import Hashing from "../crypto/hashing"
import { PeerManager } from "../peer"
import Peer from "../peer/peer"
import required from "src/utilities/required"
import * as seedrandom from "seedrandom"
import term from "terminal-kit"

import Mempool, { MempoolData } from "../blockchain/mempool"
import { io } from "socket.io-client"
import { number } from "bitcoinjs-lib/src/script"
import Block from "../blockchain/blocks"

export interface IValidator {
	connectionURL: string;
	publicKey_string: string;
	publicKey ?: forge.pki.ed25519.BinaryBuffer
}

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
export class ProofOfRepresentation {
    private common_seed: string = null
    private peers: Peer[]
    private validators: { [key: string]: IValidator | {} } = {}
    private onBlock: number = 0
    // Immutable flag to indicate that the PoR instance has been already initialized and cannot be changed anymore
    private immutable: boolean = false

    constructor() {
    }

    // INFO Creating the immutable common seed for this specific proof of representation session
    private async createSeed(on_block: number): Promise<string> {
        this.peers = await GLS.getGLSBlockNodes() // REVIEW Getting all the possible peers
        if (this.immutable) return this.common_seed // NOTE Already initialized? We got the seed!
        this.onBlock = on_block
        // Getting the immutable factors
        let lastBlockHash = await Chain.getLastBlockHash()
        let nextBlockNumber = on_block + 1
        let hashedStakes = await GLS.getGLSHashedStakes()
        // Combining the two immutable factors to improve unpredictability towards malicious validators
        let combined = lastBlockHash.concat(hashedStakes).concat(nextBlockNumber.toString())
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
    async getSeed(block_n: number = null): Promise<string> {
        if (!block_n) {
            block_n = Number(await Chain.getLastBlockNumber())
        } // REVIEW Fix sanity check here ^ to catch NaN errors
        return this.createSeed(block_n)
    }

    async getPeers(): Promise<Peer[]> {
        return this.peers
    }

    // INFO The selection algorithm
    async selectRepresentativeShard(block_n: number = null): Promise<{ [key: string]: IValidator }> {
        required(this.common_seed, "Common seed is not initialized")
        required(this.peers, "Peers are not initialized")
        if (!block_n) {
            block_n = this.onBlock
        } // REVIEW Fix sanity check here ^ to catch NaN errors
        // For safety reasons we need to enforce the immutable flag
        if (!this.immutable) {
            await this.createSeed(block_n)
            this.immutable = true
        }
        // Allocating the empty validator list
        let generatedList = {}
        let SHARD_SIZE = 10 // TODO Put in Configuration
        // Getting the base seed
        let baseSeed = await this.getSeed(block_n)
        for (let i = 0; i < SHARD_SIZE; i++) {
            // Updating the seed so that is identical for all but dynamic for the size of the shard
            let seed = baseSeed.concat(i.toString())
            // Seeding Math.random() with the seed value
            seedrandom(seed, { global: true })
            // Getting a decimal value between 0 and 1
            let decimalRandom = Math.random()
            // Getting an integer value between 0 and the number of peers
            let integerRandom = Math.floor(decimalRandom * this.peers.length) // REVIEW Does this make sense?
            let selectedPeer = this.peers[integerRandom]
            // Assigning the validator to the list
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

    async verifyRepresentativeShard(block_n: number, shard: { [key: string]: IValidator }): Promise<boolean> {
        let valid = true
        // TODO Verify that the validator list for a given block is valid
        return valid
    }

}

// INFO This class take ProofOfRepresentation and implements the PoR/QBFT methods needed for it to work correctly
export class RepresentativeShard {
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
    getShard(): ProofOfRepresentation {
        let shard = this.shard
        if (!shard) { return this.generateShard() }
        return shard
    }

    // INFO Exchanging the mempool data with the other peers and compute a pre consensus
    // to speed up the PoR process. Then, it sorts and compare a new block finalizing the
    // BFT part of the consensus.
    async representationAssembly(): Promise<[boolean, Block]> {
        let peers = await this.shard.getPeers()
        let peersNumber = peers.length
        // Setting up the tracking data
        let consensusTracking = {
            on_block: 0,
            validators: peers,
            tot_validators: peersNumber,
            results: new Map<string, boolean>(), // Where string is the hex public key and boolean is the result
        }
        // Starting
        let our_mempool = await Mempool.getMempool()
        let merged_mempool = our_mempool
        let pro = 0
        let con = 0
        // Iterating over all the validators peers
        for (let i = 0; i < peersNumber; i++) {
            let peer = peers[i]
            let peerSocket = io(peer.connectionString) // REVIEW Connection to the peer
            // TODO Ask the peer for the current mempool on its side
            let remotePool: MempoolData
            // Fast validity check is done by the Mempool module above
            let valid = await Mempool.receive(remotePool)
            if (!valid) {
                console.log("Mempool not valid")
                return [false, null]
            }
            // Merging with the remote pool as it is compatible
            let mergedResult = await Mempool.merge(remotePool)
            if (!mergedResult) { console.log("Mempool merge failed"); return [false, null] }
            // We now have the merged mempool in Mempool.getInstance()(for ex. the .transactions property)
            let compatible = true
            consensusTracking.results.set(peer.identity.toString("hex"), compatible)
            if (compatible) { pro++ } else { con++ }
        }
        // REVIEW If 2/3 + 1 have the same merged mempool, then we have a consensus
        term.yellow("[sQBFT Preliminary Validators Test] Ok: " + pro + " | Invalid: " + con + "\n")
        // Check if 2/3 + 1 are pro
        let consensusReached = this.checkConsensus(pro, con, peersNumber)
        if (!consensusReached) { return [false, null] }
        // REVIEW Sort the mempool
        let sortedPool = await Mempool.sort(await Mempool.getMempool())
        // Build the block
        let forgedProposedBlock = await Mempool.getProposedBlock()
        let forgedProposedHash = forgedProposedBlock.hash
        // REVIEW BFT for the block with the others
        let finalResult = await this.vote("forgedProposedHash", forgedProposedHash)
        return [finalResult, forgedProposedBlock]
    }

    // INFO Voting on a parameter through a list of peers and then computing the consensus
    // TODO Test and verify that works
    async vote(parameter: any, our: any): Promise<boolean> {
        let peerlist: Peer[] = await PeerManager.getInstance().getPeers()
        let numericResult = {
            pro: 0,
            con: 0,
            total: 0,
        }
        // Iterating over all the peers
        for (let i = 0; i < peerlist.length; i++) {
            let peer = peerlist[i]
            let peerSocket = io(peer.connectionString) // REVIEW Connection to the peer
            // TODO Ask the peer for the parameter on its side
            peerSocket.emit("vote", parameter) // FIXME To implement server side
            let response
            // TODO Wait for the response from the peer (maybe use a classic comlink)
            // Compiling the registry
            if (response != our) {
                numericResult.con++
            } else {
                numericResult.pro++
            }
        }
        term.yellow("[sQBFT Voting] \nParameter: " + parameter + "\nOur value: " + our + "\nOk: " + numericResult.pro + " | Invalid: " + numericResult.con + "\n")
        return this.checkConsensus(numericResult.pro, numericResult.con, numericResult.total)
    }

    // INFO Checking a generic consensus BFT
    private checkConsensus(pro: number, con: number, total: number): boolean {
        let twothirdPlus1 = (((total * 2) / 3) + 1) // REVIEW Is this correct?
        if (pro >= twothirdPlus1) {
            term.green.bold("[sQBFT] We have a theoric consensus!\n")
            return true
        } else {
            term.red.bold("[sQBFT] We don't have a theoric consensus!\n")
            return false
        }
    }

    // INFO Generating the shard if needed
    private generateShard(): ProofOfRepresentation {
        let shard = new ProofOfRepresentation()
        shard.getSeed()
        shard.selectRepresentativeShard()
        this.shard = shard
        return shard
    }

    // TODO Define methods for using the shard
}