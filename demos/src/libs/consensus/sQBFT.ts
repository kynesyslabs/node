// INFO An experimental PoR/QBFT consensus implementation
/* NOTE
	This implementation is designed to be used in DEMOS Network.
	You can call getInstance() to get an instance of this class.
	Remember to call .initialize() before using this class to maximize performances.
*/

/** NOTE Usage
 * 0. The next steps are to operate a round of PoR/QBFT consensus.
 * 1. Call sQBFT.getInstance() to get an instance of this class.
 * 2. Call sQBFT.getInstance().initialize() to generate a Representative Shard from common immutable parameters.
 * 3. Call sQBFT.getInstance().operate() to start the consensus. The following activities are performed:
 * 		a. Verify the Shard mempools for integrity and validity (TODO: in the validity one maybe we should simply leave the tx out)
 *      b. Merge the Shard mempools so that everyone has a consistent view of the network.
 *      c. Forge a possible block from the merged Shard mempool
 *      d. Call the vote one more time to vote for the block hash and return the result
 * 
 * To better understand the above steps, you can look at the source code of this class in PoR.ts
 * The above mentioned class gives you an abstract high level interface for PoR/QBFT consensus, so
 * you don't have to worry about the details of the implementation. You can anyway look at that
 * file to understand the details of the PoR/QBFT consensus and how it is implemented.
 */

import * as forge from "node-forge"
import * as por from "./PoR"
import required from "src/utilities/required"

export class sQBFT {
    private static _instance: sQBFT
	
    private representativeShard: por.RepresentativeShard = null // Importing the representative shard from the PoR module
    private isReady: boolean = false // Flag to indicate if the PoR module has been initialized
	
    constructor() {}

    public static getInstance(): sQBFT {
        if (!sQBFT._instance) {
            sQBFT._instance = new sQBFT()
        }
        return sQBFT._instance
    }
	
    public async initialize(): Promise<void> {
        // Creating the PoR result object
        if (this.isReady) {
            return
        }
        this.representativeShard = por.RepresentativeShard.getInstance()
        this.representativeShard.getShard() // Initializing or getting the representative shard statically
        // NOTE this.representativeShard.getShard() should be the same from now on
        this.isReady = true
    }

    public async operate(): Promise<void> {
        await this.representativeShard.representationAssembly()
    }
}