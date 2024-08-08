import { Peer } from "src/libs/peer"
import { ProofOfRepresentation } from "../PoR"

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
    private async generateShard(peerList: Peer[]): Promise<ProofOfRepresentation> {
        let shard = new ProofOfRepresentation()
        await shard.getSeed(undefined, peerList)
        shard.selectRepresentativeShard()
        this.shard = shard
        return shard
    }

}
