// Makes a validator NFT proof on Solana: builds, signs and sends the self
// transfer plus memo, then waits for finality. Shared by the CLI scripts.
import { Connection, Keypair, PublicKey } from "@solana/web3.js"

import {
    associatedTokenAddress,
    buildProofTransaction,
    decodeProofTransaction,
} from "../src/features/staking/proofBytes"

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"
const FINALITY_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Sign the proof for `mint` naming `demosAddress`, send it and wait until it is finalized. Returns the signature. */
export async function proveNft(
    connection: Connection,
    keypair: Keypair,
    mint: PublicKey,
    demosAddress: string,
    say: (line: string) => void,
): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized")
    const tx = buildProofTransaction({
        owner: keypair.publicKey,
        mint,
        tokenAccount: associatedTokenAddress(keypair.publicKey, mint),
        demosAddress,
        blockhash,
        lastValidBlockHeight,
    })
    tx.sign(keypair)
    const bytes = tx.serialize()
    const decoded = decodeProofTransaction(bytes)
    if (decoded.ok === false) throw new Error(`built proof does not pass the node's checks: ${decoded.reason}`)
    const signature = decoded.proof.signature

    say(`Proving NFT ${mint.toBase58()} for ${demosAddress}...`)
    try {
        await connection.sendRawTransaction(bytes)
    } catch (e) {
        throw new Error(`Solana refused the proof: ${e instanceof Error ? e.message : String(e)}`)
    }
    say(`Solana signature: ${signature}`)

    say("Waiting for Solana finality...")
    const started = Date.now()
    while (Date.now() - started < FINALITY_TIMEOUT_MS) {
        const { value: [status] } = await connection.getSignatureStatuses([signature])
        if (status?.err) throw new Error(`proof transaction failed on Solana: ${JSON.stringify(status.err)}`)
        if (status?.confirmationStatus === "finalized") {
            say("proof finalized")
            return signature
        }
        if (!status && (await connection.getBlockHeight()) > lastValidBlockHeight) {
            throw new Error("the blockhash expired before the proof landed on Solana; run the command again")
        }
        await sleep(POLL_INTERVAL_MS)
    }
    throw new Error(`finality not seen after ${FINALITY_TIMEOUT_MS / 1000}s; verify ${signature} before using it`)
}
