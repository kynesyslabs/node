/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Block from "../block"
import Transaction from "../transaction"
import Hashing from "../../crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import { serializeTransactionContent, serializeBlockContent } from "@/forks"

const GENESIS_BLOCK_HEIGHT = 0

/**
 * Block 0 and its transaction as a node creates them from `genesisData`,
 * without touching the database. The fork schedule must already be loaded:
 * it decides how block 0 serialises. scripts/genesis-hash.ts uses this to
 * publish the block 0 hash before launch.
 */
export function buildGenesisBlock(genesisData: any): { genesisBlock: Block; genesisTx: Transaction } {
    const genesisBlock = new Block()
    genesisBlock.number = 0

    const genesisTx = new Transaction()
    genesisTx.content.type = "genesis"
    genesisTx.blockNumber = 0
    genesisTx.content.to = {
        type: getSharedState.signingAlgorithm,
        data: new Uint8Array(Buffer.from("0x0", "hex")),
    }.data.toString()
    genesisTx.content.from = {
        type: getSharedState.signingAlgorithm,
        data: new Uint8Array(Buffer.from("0x0", "hex")),
    }.data.toString()
    genesisTx.content.from_ed25519_address = ""
    genesisTx.signature = {
        type: getSharedState.signingAlgorithm,
        data: "0x0",
    }
    genesisTx.status = "confirmed"

    if (!genesisData.timestamp) {
        genesisTx.content.timestamp = Date.now()
    } else {
        genesisTx.content.timestamp = parseInt(genesisData.timestamp)
    }
    genesisTx.content.amount = 0
    genesisTx.content.nonce = 0
    genesisTx.content.transaction_fee.network_fee = 0
    genesisTx.content.transaction_fee.rpc_fee = 0
    genesisTx.content.transaction_fee.additional_fee = 0

    genesisTx.hash = Hashing.sha256(
        serializeTransactionContent(genesisTx.content, GENESIS_BLOCK_HEIGHT),
    )
    // The genesis transaction has no reference block; it keeps the empty
    // attrs it has always been stored with.
    genesisTx.attrs = {} as typeof genesisTx.attrs

    genesisBlock.content.timestamp = genesisTx.content.timestamp
    genesisBlock.content.ordered_transactions.push(genesisTx.hash)
    genesisBlock.content.previousHash = "0x0"
    genesisBlock.content["extra"] = {
        genesisData: JSON.stringify(genesisData),
    }
    genesisBlock.status = "confirmed"
    genesisBlock.proposer = "0x000000000000000000000000"
    genesisBlock.content.encrypted_transactions_hashes = new Map()
    genesisBlock.validation_data = {
        signatures: {
            "0x000000000000000000000000": "0x0",
        },
    }
    genesisBlock.hash = Hashing.sha256(
        serializeBlockContent(genesisBlock.content, GENESIS_BLOCK_HEIGHT),
    )

    return { genesisBlock, genesisTx }
}
