#!/usr/bin/env bun
/**
 * ZK Proof Child Process
 *
 * Runs PLONK proof generation in a separate process to avoid blocking the main event loop.
 * Communicates via stdin/stdout JSON messages.
 *
 * Usage: bun zkProofProcess.ts <keysDir>
 */

import * as snarkjs from 'snarkjs'
import { buildPoseidon } from 'circomlibjs'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as readline from 'node:readline'

const BATCH_SIZES = [5, 10] as const
type BatchSize = typeof BATCH_SIZES[number]

let poseidon: any = null
let initialized = false
const keysDir = process.argv[2] || path.join(process.cwd(), 'src/libs/l2ps/zk/keys')

/**
 * Send response to parent process
 */
function sendResponse(response: any): void {
    process.stdout.write(JSON.stringify(response) + '\n')
}

/**
 * Initialize Poseidon hash function
 */
async function initialize(): Promise<void> {
    if (initialized) return
    poseidon = await buildPoseidon()
    initialized = true
}

/**
 * Compute Poseidon hash
 */
function hash(inputs: bigint[]): bigint {
    const F = poseidon.F
    return F.toObject(poseidon(inputs.map((x: bigint) => F.e(x))))
}

/**
 * Select the smallest batch size that fits the transaction count
 */
function selectBatchSize(txCount: number): BatchSize {
    const available = BATCH_SIZES.filter(size => {
        const zkeyPath = path.join(keysDir, `batch_${size}`, `l2ps_batch_${size}.zkey`)
        return fs.existsSync(zkeyPath)
    })

    for (const size of available) {
        if (txCount <= size) {
            return size
        }
    }

    throw new Error(`Transaction count ${txCount} exceeds available batch sizes`)
}

/**
 * Pad transactions to match batch size
 */
function padTransactions(txs: any[], targetSize: number): any[] {
    const padded = [...txs]
    while (padded.length < targetSize) {
        padded.push({
            senderBefore: 0n,
            senderAfter: 0n,
            receiverBefore: 0n,
            receiverAfter: 0n,
            amount: 0n
        })
    }
    return padded
}

/**
 * Compute state chain for transactions
 */
function computeStateChain(transactions: any[], initialStateRoot: bigint): { finalStateRoot: bigint; totalVolume: bigint } {
    let stateRoot = initialStateRoot
    let totalVolume = 0n

    for (const tx of transactions) {
        const postHash = hash([tx.senderAfter, tx.receiverAfter])
        stateRoot = hash([stateRoot, postHash])
        totalVolume += tx.amount
    }

    return { finalStateRoot: stateRoot, totalVolume }
}

/**
 * Generate PLONK proof
 */
async function generateProof(input: any): Promise<any> {
    if (!initialized) {
        await initialize()
    }

    const txCount = input.transactions.length
    if (txCount === 0) {
        throw new Error('Cannot generate proof for empty batch')
    }

    // Convert transactions - handle BigInt serialization
    const transactions = input.transactions.map((tx: any) => ({
        senderBefore: BigInt(tx.senderBefore),
        senderAfter: BigInt(tx.senderAfter),
        receiverBefore: BigInt(tx.receiverBefore),
        receiverAfter: BigInt(tx.receiverAfter),
        amount: BigInt(tx.amount)
    }))

    const initialStateRoot = BigInt(input.initialStateRoot)
    const batchSize = selectBatchSize(txCount)

    // Load keys
    const batchDir = path.join(keysDir, `batch_${batchSize}`)
    const zkeyPath = path.join(batchDir, `l2ps_batch_${batchSize}.zkey`)
    const wasmPath = path.join(batchDir, `l2ps_batch_${batchSize}_js`, `l2ps_batch_${batchSize}.wasm`)

    if (!fs.existsSync(zkeyPath) || !fs.existsSync(wasmPath)) {
        throw new Error(`Missing keys for batch_${batchSize}`)
    }

    // Pad transactions
    const paddedTxs = padTransactions(transactions, batchSize)

    // Compute expected outputs
    const { finalStateRoot, totalVolume } = computeStateChain(paddedTxs, initialStateRoot)

    // Prepare circuit inputs
    const circuitInput = {
        initial_state_root: initialStateRoot.toString(),
        final_state_root: finalStateRoot.toString(),
        total_volume: totalVolume.toString(),
        sender_before: paddedTxs.map((tx: any) => tx.senderBefore.toString()),
        sender_after: paddedTxs.map((tx: any) => tx.senderAfter.toString()),
        receiver_before: paddedTxs.map((tx: any) => tx.receiverBefore.toString()),
        receiver_after: paddedTxs.map((tx: any) => tx.receiverAfter.toString()),
        amounts: paddedTxs.map((tx: any) => tx.amount.toString())
    }

    // Generate PLONK proof
    const { proof, publicSignals } = await (snarkjs as any).plonk.fullProve(
        circuitInput,
        wasmPath,
        zkeyPath,
        null,
        {},
        { singleThread: true }
    )

    return {
        proof,
        publicSignals,
        batchSize,
        txCount,
        finalStateRoot: finalStateRoot.toString(),
        totalVolume: totalVolume.toString()
    }
}

/**
 * Verify a batch proof
 */
async function verifyProof(batchProof: any): Promise<boolean> {
    const vkeyPath = path.join(keysDir, `batch_${batchProof.batchSize}`, 'verification_key.json')

    if (!fs.existsSync(vkeyPath)) {
        throw new Error(`Missing verification key: ${vkeyPath}`)
    }

    const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'))
    return await snarkjs.plonk.verify(vkey, batchProof.publicSignals, batchProof.proof)
}

/**
 * Handle incoming request
 */
async function handleRequest(request: any): Promise<void> {
    const response: any = { id: request.id }

    try {
        switch (request.type) {
            case 'initialize':
                await initialize()
                response.type = 'result'
                response.data = { success: true }
                break

            case 'generateProof':
                response.type = 'result'
                response.data = await generateProof(request.data)
                break

            case 'verifyProof':
                response.type = 'result'
                response.data = await verifyProof(request.data)
                break

            case 'ping':
                response.type = 'result'
                response.data = { pong: true }
                break

            default:
                throw new Error(`Unknown request type: ${request.type}`)
        }
    } catch (error) {
        response.type = 'error'
        response.error = error instanceof Error ? error.message : String(error)
    }

    sendResponse(response)
}

// Read requests from stdin line by line
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
})

rl.on('line', async (line: string) => {
    try {
        const request = JSON.parse(line)
        await handleRequest(request)
    } catch (error) {
        sendResponse({
            type: 'error',
            error: `Failed to parse request: ${error instanceof Error ? error.message : error}`
        })
    }
})

// Signal ready
sendResponse({ type: 'ready' })
