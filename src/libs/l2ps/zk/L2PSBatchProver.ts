/**
 * L2PS Batch Prover
 * 
 * Generates PLONK proofs for L2PS transaction batches.
 * Automatically selects the appropriate circuit size (5, 10, or 20 tx).
 * Pads unused slots with zero-amount transfers.
 */

// Bun compatibility: patch web-worker before importing snarkjs
const isBun = (globalThis as any).Bun !== undefined;
if (isBun) {
    // Suppress web-worker errors in Bun by patching dispatchEvent
    const originalDispatchEvent = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function(event: any) {
        if (!(event instanceof Event)) {
            // Convert plain object to Event for Bun compatibility
            const realEvent = new Event(event.type || 'message');
            Object.assign(realEvent, event);
            return originalDispatchEvent.call(this, realEvent);
        }
        return originalDispatchEvent.call(this, event);
    };
}

import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { plonkVerifyBun } from './BunPlonkWrapper.js';
import log from '@/utilities/logger';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Supported batch sizes (must have pre-compiled zkeys)
// Max 10 tx per batch (batch_20 causes issues with large ptau files)
const BATCH_SIZES = [5, 10] as const;
type BatchSize = typeof BATCH_SIZES[number];
const MAX_BATCH_SIZE = 10;

export interface L2PSTransaction {
    senderBefore: bigint;
    senderAfter: bigint;
    receiverBefore: bigint;
    receiverAfter: bigint;
    amount: bigint;
}

export interface BatchProofInput {
    transactions: L2PSTransaction[];
    initialStateRoot: bigint;
}

export interface BatchProof {
    proof: any;
    publicSignals: string[];
    batchSize: BatchSize;
    txCount: number;
    finalStateRoot: bigint;
    totalVolume: bigint;
}

export class L2PSBatchProver {
    private poseidon: any;
    private initialized = false;
    private readonly keysDir: string;
    private readonly loadedKeys: Map<BatchSize, { zkey: any; wasm: string }> = new Map();

    constructor(keysDir?: string) {
        this.keysDir = keysDir || path.join(__dirname, 'keys');
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        this.poseidon = await buildPoseidon();
        
        // Verify at least one batch size is available
        const available = this.getAvailableBatchSizes();
        if (available.length === 0) {
            throw new Error(
                `No zkey files found in ${this.keysDir}. ` +
                `Run setup_all_batches.sh to generate keys.`
            );
        }
        
        log.info(`[L2PSBatchProver] Available batch sizes: ${available.join(', ')}`);
        this.initialized = true;
    }

    /**
     * Get available batch sizes (those with compiled zkeys)
     */
    getAvailableBatchSizes(): BatchSize[] {
        return BATCH_SIZES.filter(size => {
            const zkeyPath = path.join(this.keysDir, `batch_${size}`, `l2ps_batch_${size}.zkey`);
            return fs.existsSync(zkeyPath);
        });
    }

    /**
     * Get maximum supported batch size
     */
    getMaxBatchSize(): number {
        return MAX_BATCH_SIZE;
    }

    /**
     * Select the smallest batch size that fits the transaction count
     */
    private selectBatchSize(txCount: number): BatchSize {
        const available = this.getAvailableBatchSizes();
        
        if (txCount > MAX_BATCH_SIZE) {
            throw new Error(
                `Transaction count ${txCount} exceeds maximum batch size ${MAX_BATCH_SIZE}. ` +
                `Split into multiple batches.`
            );
        }
        
        for (const size of available) {
            if (txCount <= size) {
                return size;
            }
        }
        
        const maxSize = Math.max(...available);
        throw new Error(
            `Transaction count ${txCount} exceeds available batch size ${maxSize}. ` +
            `Run setup_all_batches.sh to generate more keys.`
        );
    }

    /**
     * Load circuit keys for a specific batch size
     */
    private async loadKeys(batchSize: BatchSize): Promise<{ zkey: any; wasm: string }> {
        const existing = this.loadedKeys.get(batchSize);
        if (existing) {
            return existing;
        }

        const batchDir = path.join(this.keysDir, `batch_${batchSize}`);
        const zkeyPath = path.join(batchDir, `l2ps_batch_${batchSize}.zkey`);
        const wasmPath = path.join(batchDir, `l2ps_batch_${batchSize}_js`, `l2ps_batch_${batchSize}.wasm`);

        if (!fs.existsSync(zkeyPath)) {
            throw new Error(`Missing zkey: ${zkeyPath}`);
        }
        if (!fs.existsSync(wasmPath)) {
            throw new Error(`Missing wasm: ${wasmPath}`);
        }

        const keys = { zkey: zkeyPath, wasm: wasmPath };
        this.loadedKeys.set(batchSize, keys);
        return keys;
    }

    /**
     * Compute Poseidon hash
     */
    private hash(inputs: bigint[]): bigint {
        const F = this.poseidon.F;
        return F.toObject(this.poseidon(inputs.map(x => F.e(x))));
    }

    /**
     * Pad transactions to match batch size with zero-amount transfers
     */
    private padTransactions(txs: L2PSTransaction[], targetSize: BatchSize): L2PSTransaction[] {
        const padded = [...txs];
        
        while (padded.length < targetSize) {
            // Zero-amount transfer (no-op)
            padded.push({
                senderBefore: 0n,
                senderAfter: 0n,
                receiverBefore: 0n,
                receiverAfter: 0n,
                amount: 0n
            });
        }
        
        return padded;
    }

    /**
     * Compute state transitions and final state root
     */
    private computeStateChain(
        transactions: L2PSTransaction[],
        initialStateRoot: bigint
    ): { finalStateRoot: bigint; totalVolume: bigint } {
        let stateRoot = initialStateRoot;
        let totalVolume = 0n;

        for (const tx of transactions) {
            // Compute post-state hash for this transfer
            const postHash = this.hash([tx.senderAfter, tx.receiverAfter]);
            
            // Chain state: combine previous state with new transfer
            stateRoot = this.hash([stateRoot, postHash]);
            
            // Accumulate volume
            totalVolume += tx.amount;
        }

        return { finalStateRoot: stateRoot, totalVolume };
    }

    /**
     * Generate a PLONK proof for a batch of transactions
     */
    async generateProof(input: BatchProofInput): Promise<BatchProof> {
        if (!this.initialized) {
            await this.initialize();
        }

        const txCount = input.transactions.length;
        if (txCount === 0) {
            throw new Error('Cannot generate proof for empty batch');
        }

        // Select appropriate batch size
        const batchSize = this.selectBatchSize(txCount);
        log.debug(`[L2PSBatchProver] Using batch_${batchSize} for ${txCount} transactions`);

        // Load keys
        const { zkey, wasm } = await this.loadKeys(batchSize);

        // Pad transactions
        const paddedTxs = this.padTransactions(input.transactions, batchSize);

        // Compute expected outputs
        const { finalStateRoot, totalVolume } = this.computeStateChain(
            paddedTxs,
            input.initialStateRoot
        );

        // Prepare circuit inputs
        const circuitInput = {
            initial_state_root: input.initialStateRoot.toString(),
            final_state_root: finalStateRoot.toString(),
            total_volume: totalVolume.toString(),
            sender_before: paddedTxs.map(tx => tx.senderBefore.toString()),
            sender_after: paddedTxs.map(tx => tx.senderAfter.toString()),
            receiver_before: paddedTxs.map(tx => tx.receiverBefore.toString()),
            receiver_after: paddedTxs.map(tx => tx.receiverAfter.toString()),
            amounts: paddedTxs.map(tx => tx.amount.toString())
        };

        // Generate PLONK proof (with singleThread for Bun compatibility)
        log.debug(`[L2PSBatchProver] Generating proof...`);
        const startTime = Date.now();
        
        // Use fullProve with singleThread option to avoid Web Workers
        const { proof, publicSignals } = await (snarkjs as any).plonk.fullProve(
            circuitInput,
            wasm,
            zkey,
            null,  // logger
            {},    // wtnsCalcOptions
            { singleThread: true }  // proverOptions - avoid web workers
        );

        const duration = Date.now() - startTime;
        log.info(`[L2PSBatchProver] Proof generated in ${duration}ms`);

        return {
            proof,
            publicSignals,
            batchSize,
            txCount,
            finalStateRoot,
            totalVolume
        };
    }

    /**
     * Verify a batch proof
     */
    async verifyProof(batchProof: BatchProof): Promise<boolean> {
        const vkeyPath = path.join(
            this.keysDir,
            `batch_${batchProof.batchSize}`,
            'verification_key.json'
        );

        if (!fs.existsSync(vkeyPath)) {
            throw new Error(`Missing verification key: ${vkeyPath}`);
        }

        const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));
        
        const startTime = Date.now();
        
        // Use Bun-compatible wrapper (uses singleThread mode to avoid worker crashes)
        const isBun = (globalThis as any).Bun !== undefined;
        let valid: boolean;
        
        if (isBun) {
            // Use Bun-compatible wrapper that avoids web workers
            valid = await plonkVerifyBun(vkey, batchProof.publicSignals, batchProof.proof);
        } else {
            // Use snarkjs directly in Node.js
            valid = await snarkjs.plonk.verify(vkey, batchProof.publicSignals, batchProof.proof);
        }
        
        const duration = Date.now() - startTime;
        
        log.debug(`[L2PSBatchProver] Verification: ${valid ? 'VALID' : 'INVALID'} (${duration}ms)`);
        
        return valid;
    }

    /**
     * Export proof for on-chain verification (Solidity calldata)
     */
    async exportCalldata(batchProof: BatchProof): Promise<string> {
        // snarkjs plonk.exportSolidityCallData may not exist in all versions
        const plonkModule = snarkjs.plonk as any;
        if (typeof plonkModule.exportSolidityCallData === 'function') {
            return await plonkModule.exportSolidityCallData(
                batchProof.proof,
                batchProof.publicSignals
            );
        }
        // Fallback: return JSON stringified proof
        return JSON.stringify({
            proof: batchProof.proof,
            publicSignals: batchProof.publicSignals
        });
    }
}

export default L2PSBatchProver;
