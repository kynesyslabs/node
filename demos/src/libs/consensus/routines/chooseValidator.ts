/* INFO
   To be able to choose the same set of validators and at the same time to
   discourage malicious or bugged nodes from tampering with the network, we
   implement a pseudo-randomic algorithm having as seed a string made of:
	 - The last block hash (double checks on chain integrity)
	 - The current proposable block of the node hash (so that malicious actors or 
													  actors with invalid/incompatible 
													  blocks automatically fork if they 
													  meet and will never be chosen by 
													  the majority of the chain)
*/
import * as seedrandom from "seedrandom"
console.log(seedrandom)

import Chain from "src/libs/blockchain/chain"
import Block from "src/libs/blockchain/blocks"
import Transaction from "src/libs/blockchain/transaction"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import Mempool from "src/libs/blockchain/mempool"
import { Hash } from "crypto"
import { Peer } from "src/libs/peer"

// INFO Choosing validators for this round using a pseudo-random number generator
//      using some unique cryptographic numbers common to all the nodes that obtained
//		the same proposed block.
export default async function chooseValidator(peers: Peer[]) {
    let block = await Mempool.getProposedBlock()
    // REVIEW Is better to hex the bytes directly?
    let block_hash = Hashing.sha256(JSON.stringify(block)) // FIXME Replace with something that is order-resistant
    /* TODO Choose the right variables for the CVSA
        - Sorted mempool with invalid tx scrapped, encrypted
        - Using only transactions < consensus timestamp to ensure synchronization
        - REVIEW Clock sync
        - REVIEW TX Timestamp tamper
    */
    // TODO See how it returns and parse it correctly
    let last_block_hash = await Chain.getLastBlockHash()
    // REVIEW Pseudo random number with the above variables as seed
    let seed = last_block_hash + block_hash
    let generator = seedrandom(seed)
    let randomNumber = generator()
    let result: number
    let control = 0
    // REVIEW Optimize this loop (is a simple cycled counter)
    for (result = 0; result < randomNumber; result++) {
        control++
        if (control > peers.length) {
            control =0
        }
    }
    return peers[control] // Validator chosen
}

/* TODO Representative Shard

    Deterministic group selection
    - The group sync the mempool and exclude the invalid transactions
    - mempool sort by gas fee bid (see gas fee in yp) -> market of nodes buziness
    - BFT
    */
