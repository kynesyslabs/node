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
    EventTarget.prototype.dispatchEvent = function (event: any) {
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
import { spawn, ChildProcess } from 'node:child_process';
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

    /** Child process for non-blocking proof generation */
    private childProcess: ChildProcess | null = null;
    private processReady = false;
    private readonly pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
    private requestCounter = 0;
    private responseBuffer = '';

    /** Whether to use subprocess (non-blocking) or main thread */
    private useSubprocess = true;

    constructor(keysDir?: string) {
        this.keysDir = keysDir || path.join(__dirname, 'keys');

        // Check environment variable to disable subprocess
        if (process.env.L2PS_ZK_USE_MAIN_THREAD === 'true') {
            this.useSubprocess = false;
            log.info('[L2PSBatchProver] Subprocess disabled by L2PS_ZK_USE_MAIN_THREAD');
        }
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

        // Initialize subprocess for non-blocking proof generation
        if (this.useSubprocess) {
            await this.initializeSubprocess();
        }

        log.info(`[L2PSBatchProver] Available batch sizes: ${available.join(', ')} (subprocess: ${this.useSubprocess && this.processReady})`);
        this.initialized = true;
    }

    /**
     * Initialize child process for proof generation
     */
    private async initializeSubprocess(): Promise<void> {
        return new Promise((resolve) => {
            try {
                const processPath = path.join(__dirname, 'zkProofProcess.ts');

                // Spawn child process using bun or node
                const runtime = isBun ? 'bun' : 'npx';
                const args = isBun
                    ? [processPath, this.keysDir]
                    : ['tsx', processPath, this.keysDir];

                log.debug(`[L2PSBatchProver] Spawning: ${runtime} ${args.join(' ')}`);

                this.childProcess = spawn(runtime, args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: process.cwd()
                });

                // Handle stdout - responses from child process
                this.childProcess.stdout?.on('data', (data: Buffer) => {
                    this.responseBuffer += data.toString();
                    this.processResponseBuffer();
                });

                // Handle stderr - log errors
                this.childProcess.stderr?.on('data', (data: Buffer) => {
                    const msg = data.toString().trim();
                    if (msg) {
                        log.debug(`[L2PSBatchProver] Process stderr: ${msg}`);
                    }
                });

                this.childProcess.on('error', (error) => {
                    log.error(`[L2PSBatchProver] Process error: ${error.message}`);
                    this.processReady = false;
                    // Reject all pending requests
                    for (const [id, pending] of this.pendingRequests) {
                        pending.reject(error);
                        this.pendingRequests.delete(id);
                    }
                });

                this.childProcess.on('exit', (code) => {
                    if (code !== 0 && code !== null) {
                        log.error(`[L2PSBatchProver] Process exited with code ${code}`);
                    }
                    this.processReady = false;
                    this.childProcess = null;
                });

                // Wait for ready signal
                const readyTimeout = setTimeout(() => {
                    if (!this.processReady) {
                        log.warning('[L2PSBatchProver] Process initialization timeout, using main thread');
                        this.useSubprocess = false;
                        resolve();
                    }
                }, 15000);

                // Set up ready handler
                const checkReady = (response: any) => {
                    if (response.type === 'ready') {
                        clearTimeout(readyTimeout);
                        this.processReady = true;
                        log.info('[L2PSBatchProver] Subprocess initialized');
                        resolve();
                    }
                };
                this.pendingRequests.set('__ready__', { resolve: checkReady, reject: () => { } });

            } catch (error) {
                log.warning(`[L2PSBatchProver] Failed to spawn subprocess: ${error instanceof Error ? error.message : String(error)}`);
                this.useSubprocess = false;
                resolve(); // Continue without subprocess
            }
        });
    }

    /**
     * Process buffered responses from child process
     */
    private processResponseBuffer(): void {
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const response = JSON.parse(line);

                // Handle ready signal
                if (response.type === 'ready') {
                    const readyHandler = this.pendingRequests.get('__ready__');
                    if (readyHandler) {
                        this.pendingRequests.delete('__ready__');
                        readyHandler.resolve(response);
                    }
                    continue;
                }

                // Handle regular responses
                const pending = this.pendingRequests.get(response.id);
                if (pending) {
                    this.pendingRequests.delete(response.id);
                    if (response.type === 'error') {
                        pending.reject(new Error(response.error || 'Unknown process error'));
                    } else {
                        pending.resolve(response.data);
                    }
                }
            } catch {
                log.debug(`[L2PSBatchProver] Failed to parse response line (invalid JSON): ${line.slice(0, 100)}...`);
            }
        }
    }

    /**
     * Send request to subprocess and wait for response
     */
    private subprocessRequest<T>(type: string, data?: any): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this.childProcess || !this.processReady) {
                reject(new Error('Subprocess not available'));
                return;
            }

            const id = `req_${++this.requestCounter}`;
            const request = JSON.stringify({ type, id, data }) + '\n';

            this.pendingRequests.set(id, { resolve, reject });

            // Set timeout for request
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Subprocess request timeout'));
                }
            }, 120000); // 2 minute timeout for proof generation

            this.pendingRequests.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                }
            });

            this.childProcess.stdin?.write(request);
        });
    }

    /**
     * Terminate subprocess
     */
    async terminate(): Promise<void> {
        if (this.childProcess) {
            this.childProcess.kill();
            this.childProcess = null;
            this.processReady = false;
            log.info('[L2PSBatchProver] Subprocess terminated');
        }
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
     * Uses subprocess to avoid blocking the main event loop
     */
    async generateProof(input: BatchProofInput): Promise<BatchProof> {
        if (!this.initialized) {
            await this.initialize();
        }

        const txCount = input.transactions.length;
        if (txCount === 0) {
            throw new Error('Cannot generate proof for empty batch');
        }

        const startTime = Date.now();

        // Try subprocess first (non-blocking)
        if (this.useSubprocess && this.processReady) {
            try {
                log.debug(`[L2PSBatchProver] Generating proof in subprocess (${txCount} transactions)...`);

                // Serialize BigInts to strings for IPC
                const processInput = {
                    transactions: input.transactions.map(tx => ({
                        senderBefore: tx.senderBefore.toString(),
                        senderAfter: tx.senderAfter.toString(),
                        receiverBefore: tx.receiverBefore.toString(),
                        receiverAfter: tx.receiverAfter.toString(),
                        amount: tx.amount.toString()
                    })),
                    initialStateRoot: input.initialStateRoot.toString()
                };

                const result = await this.subprocessRequest<{
                    proof: any;
                    publicSignals: string[];
                    batchSize: number;
                    txCount: number;
                    finalStateRoot: string;
                    totalVolume: string;
                }>('generateProof', processInput);

                const duration = Date.now() - startTime;
                log.info(`[L2PSBatchProver] Proof generated in ${duration}ms (subprocess)`);

                return {
                    proof: result.proof,
                    publicSignals: result.publicSignals,
                    batchSize: result.batchSize as BatchSize,
                    txCount: result.txCount,
                    finalStateRoot: BigInt(result.finalStateRoot),
                    totalVolume: BigInt(result.totalVolume)
                };
            } catch (error) {
                log.warning(`[L2PSBatchProver] Subprocess failed, falling back to main thread: ${error instanceof Error ? error.message : String(error)}`);
                // Fall through to main thread execution
            }
        }

        // Fallback to main thread (blocking)
        return this.generateProofMainThread(input, startTime);
    }

    /**
     * Generate proof on main thread (blocking - fallback)
     */
    private async generateProofMainThread(input: BatchProofInput, startTime: number): Promise<BatchProof> {
        const txCount = input.transactions.length;

        // Select appropriate batch size
        const batchSize = this.selectBatchSize(txCount);
        log.debug(`[L2PSBatchProver] Using batch_${batchSize} for ${txCount} transactions (main thread)`);

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
        log.debug(`[L2PSBatchProver] Generating proof on main thread...`);

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
        log.info(`[L2PSBatchProver] Proof generated in ${duration}ms (main thread - blocking)`);

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
