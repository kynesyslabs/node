import log from "src/utilities/logger"
import Block from "./block"
import Mempool from "./mempool"
import Transaction from "./transaction"
import Hashing from "../crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import HandleGCR from "./gcr/handleGCR"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { insertBlock } from "./chainBlocks"
import type { Operation } from "@kynesyslabs/demosdk/types"
import {
    serializeTransactionContent,
    serializeBlockContent,
} from "@/forks"

// REVIEW: P2 — genesis is always block 0; route both genesis hashes through
// the fork-aware serializer for symmetry. The gate is bit-identical in P2.
const GENESIS_BLOCK_HEIGHT = 0

export async function generateGenesisBlock(genesisData: any): Promise<Block> {
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

    const { commonValidatorSeed } = await getCommonValidatorSeed(
        genesisBlock as any,
    )
    genesisBlock.next_proposer = commonValidatorSeed

    const genesisOp: Operation = {
        operator: "genesis",
        actor: "DEMOS Network",
        params: genesisData,
        hash: genesisBlock.hash,
        nonce: 0,
        timestamp: genesisBlock.content.timestamp,
        status: true,
        fees: {
            network_fee: 0,
            rpc_fee: 0,
            additional_fee: 0,
            // DEM-665: Operations are internal — they do not carry a
            // routing rpc_address. The field is structurally required
            // by the SDK's TxFee interface so we set `null`.
            rpc_address: null,
        },
    }

    log.debug("[GENESIS] Block generated, ready to insert it")
    log.debug("[GENESIS] inserting transaction into the mempool")
    await Mempool.addTransaction({ ...genesisTx, reference_block: 0 })
    log.debug("[GENESIS] inserted transaction")

    // SECTION: Restoring account data
    const users = {}

    for (const balance of genesisData.balances) {
        const user = {
            pubkey: balance[0],
            balance: balance[1],
        }
        users[user.pubkey] = user
    }

    for (const user of genesisData?.users || []) {
        const balance = users[user.pubkey]?.balance || 0n
        users[user.pubkey] = {
            ...user,
            balance: balance,
        }
    }

    const userAccounts: Record<string, any>[] = Object.values(users)
    log.debug(`total users: ${userAccounts.length}`)

    const batchSize = 100
    for (let i = 0; i < userAccounts.length; i += batchSize) {
        const batch = userAccounts.slice(i, i + batchSize)
        log.info(
            `[GENESIS] Processing batch ${
                Math.floor(i / batchSize) + 1
            }/${Math.ceil(userAccounts.length / batchSize)} (${
                batch.length
            } accounts)`,
        )

        await Promise.all(
            batch.map(async user => {
                await HandleGCR.createAccount(user.pubkey, user)
            }),
        )
    }
    // !SECTION Restoring account data

    await insertBlock(genesisBlock, [genesisOp], 0)
    return genesisBlock
}

export async function generateGenesisBlocks(genesisJsons: any[]): Promise<string> {
    const compiledBlock = ""
    // TODO
    return compiledBlock
}

export async function getGenesisUniqueBlock() {
    // TODO
}
