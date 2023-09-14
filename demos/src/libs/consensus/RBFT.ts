// INFO An experimental PoR/BFT consensus implementation

/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* NOTE
	This implementation is designed to be used in DEMOS Network.
	You can call getInstance() to get an instance of this class.
	Remember to call .initialize() before using this class to maximize performances.
*/

/** NOTE Usage
 * 0. The next steps are to operate a round of PoR/BFT consensus.
 * 1. Call rBFT.getInstance() to get an instance of this class.
 * 2. Call rBFT.getInstance().initialize() to generate a Representative Shard from common immutable parameters.
 * 3. Call rBFT.getInstance().operate() to start the consensus. The following activities are performed:
 * 		a. Verify the Shard mempools for integrity and validity (TODO: in the validity one maybe we should simply leave the tx out)
 *      b. Merge the Shard mempools so that everyone has a consistent view of the network.
 *      c. Forge a possible block from the merged Shard mempool
 *      d. Call the vote one more time to vote for the block hash and return the result
 * 
 * To better understand the above steps, you can look at the source code of this class in PoR.ts
 * The above mentioned class gives you an abstract high level interface for PoR/BFT consensus, so
 * you don't have to worry about the details of the implementation. You can anyway look at that
 * file to understand the details of the PoR/BFT consensus and how it is implemented.
 */

import * as forge from "node-forge"
import RepresentativeShard from "./types/PoR"
import BFT from "./types/BFT"
import Block from "../blockchain/blocks"

// INFO The rBFT class gathers and conveniently exposes the high level interface for PoR/BFT consensus.
export class rBFT {
    private static _instance: rBFT
	
    private representativeShard: RepresentativeShard = null // Importing the representative shard from the PoR module
    private isReady: boolean = false // Flag to indicate if the PoR module has been initialized
	
    constructor() {}

    // INFO Singleton: we cannot have more than one instance of this class at a time
    public static getInstance(): rBFT {
        if (!rBFT._instance) {
            rBFT._instance = new rBFT()
        }
        return rBFT._instance
    }
	
    // INFO Uses PoR module to generate a Representative Shard from common immutable parameters
    public async initialize(): Promise<void> {
        // Creating the PoR result object
        if (this.isReady) {
            return
        }
        this.representativeShard = RepresentativeShard.getInstance()
        this.representativeShard.getShard() // Initializing or getting the representative shard statically
        // NOTE this.representativeShard.getShard() should be the same from now on
        this.isReady = true
    }

    // INFO Launches a round of BFT consensus within the Representative Shard and returns the result
    public async operate(): Promise<[boolean, Block]> {
        return await BFT.representationAssembly(this.representativeShard)
    }
}