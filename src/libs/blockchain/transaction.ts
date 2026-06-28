/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// INFO This module exposes a set of functions that can be used to work on transactions
// NOTE It also exposes methods that will be used to process transactions

/* TODO About being gas free

NOTE: The fee is locked by the node and released when the block itself is confirmed

*/
import {
    RawTransaction,
    Transaction as ITransaction,
} from "@kynesyslabs/demosdk/types"
import type { ISignature } from "@kynesyslabs/demosdk/types"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import Hashing from "../crypto/hashing"
import Confirmation from "./types/confirmation"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "@/utilities/sharedState"
import log from "src/utilities/logger"
import prefetchIdentities from "./validation/prefetchIdentities"
import { validateTxSignature } from "./validation/txValidator"
import TxValidatorPool from "./validation/txValidatorPool"
import { serializeTransactionContent } from "@/forks"
import { Transactions } from "@/model/entities/Transactions"
import type { TransactionStatus } from "@/utilities/constants"

interface TransactionResponse {
    status: string
    code: number
    message: string
    data: {}
}

export default class Transaction implements ITransaction {
    // Properties automatically follow ITransaction interface
    content: TransactionContent | null = null
    signature: ISignature | null = null
    ed25519_signature: string | null = null
    hash: string | null = null
    status: string | TransactionStatus | null = null
    blockNumber: number | null = null

    constructor(data?: Partial<ITransaction>) {
        // Initialize with defaults or provided data
        Object.assign(this, {
            content: {
                type: null,
                from: "",
                from_ed25519_address: "",
                to: "",
                amount: null,
                data: [null, null],
                gcr_edits: [],
                nonce: null,
                timestamp: null,
                transaction_fee: {
                    network_fee: null,
                    rpc_fee: null,
                    additional_fee: null,
                    // DEM-665: populated post-fork by the validating
                    // node in confirmTransaction (P6). Pre-fork rows
                    // and freshly-constructed unsent transactions
                    // carry `null`.
                    rpc_address: null,
                },
            },
            signature: null,
            ed25519_signature: null,
            hash: null,
            status: null,
            blockNumber: null,
            ...data,
        })
    }

    // INFO Given a transaction, sign it with the private key of the sender
    public static async sign(
        tx: Transaction,
        blockHeight?: number,
    ): Promise<[boolean, any]> {
        // Check sanity of the structure of the tx object
        if (!tx.content) {
            return [false, "Missing tx.content"]
        }
        // REVIEW: P2 — route through fork-aware serializer. In P2 the gate
        // returns identical bytes to JSON.stringify(tx.content), preserving
        // signatures bit-for-bit.
        const height = blockHeight ?? getSharedState.lastBlockNumber ?? 0
        const signature_ = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(
                serializeTransactionContent(tx.content, height),
            ),
        )

        if (!signature_) {
            return [false, "Failed to sign transaction"]
        }
        return [
            true,
            {
                type: getSharedState.signingAlgorithm,
                data: uint8ArrayToHex(signature_.signature),
            },
        ]
    }

    // INFO Hashing the content of a transaction
    static hash(tx: Transaction, blockHeight?: number): any {
        // REVIEW: P2 — route through fork-aware serializer. In P2 the gate
        // returns identical bytes to JSON.stringify(tx.content), so every
        // existing tx hash is preserved exactly.
        const height = blockHeight ?? getSharedState.lastBlockNumber ?? 0
        const hash = Hashing.sha256(
            serializeTransactionContent(tx.content, height),
        )
        if (!hash) {
            return false
        } else {
            tx.hash = hash
            return tx
        }
    }

    // INFO Compile a verification for a transaction and spit out the resulting tx
    static async confirmTx(
        tx: Transaction,
        sender: string,
        // publicKey: forge.pki.ed25519.BinaryBuffer,
        // privateKey: forge.pki.ed25519.BinaryBuffer,
    ) {
        const structured = this.structured(tx)
        if (!structured.valid) {
            return {
                success: false,
                message: structured.message,
                confirmation: null,
            }
        }

        const { success, message } = await this.validateSignature(tx, sender)

        if (!success) {
            return {
                success: false,
                message: message,
                confirmation: null,
            }
        }

        const isCoherent = this.isCoherent(tx)

        if (!isCoherent) {
            return {
                success: false,
                message: "Transaction hash mismatch",
                confirmation: null,
            }
        }

        const confirmation = new Confirmation()
        confirmation.data.validator = getSharedState.keypair
            .publicKey as Uint8Array
        confirmation.data.tx_hash_validated = tx.hash
        const signature = await TxValidatorPool.getInstance().sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(JSON.stringify(confirmation.data)),
        )
        confirmation.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }

        return {
            success: true,
            message: "Transaction validated",
            confirmation: confirmation,
        }
    }

    // INFO Checks the integrity of a transaction
    public static async validateSignature(
        tx: Transaction,
        sender: string = null,
    ): Promise<{ success: boolean; message: string }> {
        // INFO: Ensure tx signer is the sender of the tx request
        // TIP: This function is also called without the sender to validate mempool txs
        if (
            sender &&
            (tx.content.from != sender ||
                (tx.signature.type === "ed25519" &&
                    tx.content.from_ed25519_address != sender))
        ) {
            return {
                success: false,
                message: "Transaction signer does not match sender address",
            }
        }

        // Delegate the actual coherence-skipping signature verification to the
        // pure validator so this method and Mempool.receive share one source of
        // truth for the crypto rules. The DB lookup that the PQC-no-co-signature
        // branch needs is pre-resolved here as a single-tx prefetch.
        const hints = await prefetchIdentities([tx])
        const result = await validateTxSignature(tx, hints[tx.hash] ?? null)

        return {
            success: result.valid,
            message: result.valid
                ? "Transaction signature verified"
                : result.reason,
        }
    }

    // INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
    public static isCoherent(tx: Transaction, blockHeight?: number) {
        // REVIEW: P2 — route through fork-aware serializer. In P2 the gate
        // returns identical bytes to JSON.stringify(tx.content), so legacy
        // tx hashes still match when re-derived. When a caller has the
        // owning block context, it should pass `block.number`; otherwise
        // we fall back to the chain head.
        const height = blockHeight ?? getSharedState.lastBlockNumber ?? 0
        const derivedHash = Hashing.sha256(
            serializeTransactionContent(tx.content, height),
        )

        return derivedHash === tx.hash
    }

    /**
     * Validates the 'to' field of a transaction to ensure it's a valid Ed25519 public key.
     *
     * @param {any} to - The 'to' field value to validate. Can be one of:
     *   - A hex string representing a 32-byte Ed25519 public key
     *   - A Buffer containing a 32-byte Ed25519 public key
     *   - A JSON object with format {type: "Buffer", data: number[]}
     *
     * @returns {Object} An object containing:
     *   - valid: boolean - Whether the 'to' field is valid
     *   - message: string - Description of the validation result or error
     *
     * @example
     * // Valid hex string
     * validateToField("5e2320ef...") // 32 bytes in hex
     *
     * // Valid Buffer
     * validateToField(Buffer.from([94, 35, ...])) // 32 bytes
     *
     * // Valid JSON Buffer format
     * validateToField({type: "Buffer", data: [94, 35, ...]}) // 32 bytes
     */
    private static validateToField(to: any): {
        valid: boolean
        message: string
    } {
        // Step 1: Check if the field exists
        if (!to) {
            return {
                valid: false,
                message: "Missing TO field",
            }
        }

        try {
            // Step 2: Convert input to Buffer based on its format
            const toBuffer = this.convertToBuffer(to)
            if (!toBuffer) {
                return {
                    valid: false,
                    message: "Failed to convert TO field to Buffer",
                }
            }

            // Step 3: Validate buffer length (must be exactly 32 bytes for Ed25519)
            if (toBuffer.length !== 32) {
                return {
                    valid: false,
                    message: `TO field must be exactly 32 bytes (received ${toBuffer.length} bytes)`,
                }
            }

            // Step 4: Validate as Ed25519 public key
            // We'll just verify it's a 32-byte buffer, which is the correct size for a raw Ed25519 public key
            // NOTE: any 32-byte buffer is a valid Ed25519 public key (not just the ones generated by forge)

            // All validations passed
            return {
                valid: true,
                message: "TO field is valid",
            }
        } catch (e) {
            log.error(
                `[TX] validateToField - Error validating TO field: ${e instanceof Error ? e.message : String(e)}`,
            )
            return {
                valid: false,
                message: `Error validating TO field: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            }
        }
    }

    // NOTE: If this helper function works flawlessly, we can use it in other places too
    /**
     * Converts various formats to a Buffer that can represent an Ed25519 public key
     * @param input - The input to convert (string, Buffer, JSON Buffer, or Forge buffer)
     * @returns A Buffer or null if conversion failed
     */
    private static convertToBuffer(input: any): Buffer | null {
        try {
            // Case 1: Hex string format (e.g., "5e2320ef..." or "0x5e2320ef...")
            if (typeof input === "string") {
                // Remove "0x" prefix if present
                const hexString = input.startsWith("0x")
                    ? input.substring(2)
                    : input
                const buffer = Buffer.from(hexString, "hex")

                // Add warning if the string doesn't start with "0x"
                if (!input.startsWith("0x")) {
                    log.warning(
                        "[TX] convertToBuffer - Hex string should start with '0x' prefix for consistency",
                    )
                }

                return buffer
            }

            // Case 2: Direct Buffer format
            if (Buffer.isBuffer(input)) {
                return input
            }

            // Case 3: JSON Buffer format (e.g., {type: "Buffer", data: [94, 35, ...]})
            if (
                typeof input === "object" &&
                input.type === "Buffer" &&
                Array.isArray(input.data)
            ) {
                return Buffer.from(input.data)
            }

            // Case 4: Forge Ed25519 buffer format (BinaryBuffer or NativeBuffer)
            if (
                typeof input === "object" &&
                input !== null &&
                typeof input.getBytes === "function"
            ) {
                return Buffer.from(input.getBytes())
            }

            // Unsupported format
            log.debug(
                "[TX] convertToBuffer - TO field is not in a valid format",
            )
            return null
        } catch (e) {
            log.error(
                `[TX] convertToBuffer - Error converting TO field to Buffer: ${e instanceof Error ? e.message : String(e)}`,
            )
            return null
        }
    }
    /**
     * Validates a storage address format (stor-{40 hex chars})
     * Used for StorageProgram transaction type where 'to' field is a storage address
     */
    private static validateStorageAddress(to: string): {
        valid: boolean
        message: string
    } {
        if (!to || typeof to !== "string") {
            return {
                valid: false,
                message: "Missing or invalid storage address",
            }
        }

        // Storage address format: stor-{40 hex chars}
        const storageAddressRegex = /^stor-[0-9a-f]{40}$/i
        if (!storageAddressRegex.test(to)) {
            log.debug(
                `[TX] validateStorageAddress - Invalid storage address format: ${to}`,
            )
            return {
                valid: false,
                message: `Invalid storage address format: ${to}. Expected: stor-{40 hex chars}`,
            }
        }

        log.debug("[TX] validateStorageAddress - Storage address is valid")
        return {
            valid: true,
            message: "Storage address is valid",
        }
    }

    // Modify the structured method to use the new validation
    public static structured(tx: Transaction): {
        valid: boolean
        message: string
    } {
        // REVIEW: StorageProgram transactions use stor-{hash} format for 'to' field
        // instead of Ed25519 public key, so we use different validation
        if (tx.content.type === "storageProgram") {
            const storageValidation = this.validateStorageAddress(
                tx.content.to as string,
            )
            if (!storageValidation.valid) {
                return {
                    valid: false,
                    message: storageValidation.message,
                }
            }
        } else {
            // Validate TO field as Ed25519 public key for non-storage transactions
            const toValidation = this.validateToField(tx.content.to)
            if (!toValidation.valid) {
                return {
                    valid: false,
                    message: toValidation.message,
                }
            }
        }

        // TODO: Add other structural validations here
        // For example:
        // - Validate FROM field
        // - Validate amount
        // - Validate timestamp
        // - Validate nonce
        // etc.

        return {
            valid: true,
            message: "Transaction is structurally valid",
        }
    }

    public static toRawTransaction(tx: Transaction): RawTransaction {
        // NOTE From and To can be either a string or a Buffer
        if (tx.content.to["data"]?.toString("hex")) {
            tx.content.to = tx.content.to["data"]?.toString("hex")
        }
        if (tx.content.from["data"]?.toString("hex")) {
            tx.content.from = tx.content.from["data"]?.toString("hex")
        }

        // REVIEW P5a: returns the SDK `RawTransaction` shape (`amount` and
        // fees as `string | number`). Callers (`insertTransaction`,
        // `chainBlocks.insertBlock`) pass this to TypeORM `save()`, which
        // accepts `string | number` for `bigint` columns at runtime — but
        // the entity's static type declares `bigint`, so we can't directly
        // assign. The `saveTransactionEntity` helper below bridges the
        // type without changing the runtime payload (`JSON.stringify` of
        // the raw tx still works because no `bigint` is introduced).
        const rawTx = {
            blockNumber: tx.blockNumber,
            signature: JSON.stringify(tx.signature), // REVIEW This is a horrible thing, if it even works
            ed25519_signature: tx.ed25519_signature,
            status: tx.status,
            hash: tx.hash,
            content: JSON.stringify(tx.content),
            type: tx.content.type,
            from_ed25519_address: tx.content.from_ed25519_address,

            to: tx.content.to,
            from: tx.content.from,
            amount: tx.content.amount,
            nonce: tx.content.nonce,
            timestamp: tx.content.timestamp,
            networkFee: tx.content.transaction_fee.network_fee,
            rpcFee: tx.content.transaction_fee.rpc_fee,
            additionalFee: tx.content.transaction_fee.additional_fee,
            // DEM-665: rpcAddress is null on pre-fork rows and on
            // freshly-constructed transactions before confirmTransaction
            // runs (P6). The DB column is nullable.
            rpcAddress: tx.content.transaction_fee.rpc_address ?? null,
            id: 0, // ? What is this?
        }

        return rawTx
    }

    public static fromRawTransaction(
        rawTx: RawTransaction | Transactions,
    ): Transaction {
        if (!rawTx) {
            return null
        }

        const tx = new Transaction()

        tx.blockNumber = rawTx.blockNumber
        tx.signature = JSON.parse(rawTx.signature) as ISignature
        tx.status = rawTx.status
        tx.hash = rawTx.hash
        tx.content = {
            type: rawTx.type as
                | "web2Request"
                | "crosschainOperation"
                | "demoswork" // ! Remove this horrible thing when possible
                | "NODE_ONLINE",
            from: rawTx.from,
            to: rawTx.to,
            from_ed25519_address: rawTx.from_ed25519_address,
            // REVIEW P5a: callers pass either the SDK `RawTransaction` shape
            // (`amount: string | number`) or the TypeORM `Transactions`
            // entity (`amount: bigint`). Coerce to the wire-format shape
            // (`number`) the rest of the node still expects pre-fork; the
            // serializerGate transforms to OS string when the fork
            // activates. Bit-identical to pre-bump behavior: TypeORM
            // historically returned `bigint` columns as JS strings/numbers
            // depending on driver, and `Number(bigint | string | number)` is
            // what the legacy code path produced.
            amount: fromEntityToWireNumber(rawTx.amount),
            nonce: rawTx.nonce,
            timestamp: rawTx.timestamp,
            transaction_fee: {
                // REVIEW The Transactions entity stores fees as `bigint` columns;
                // TypeORM hands them back to us as JS strings (or bigint) on
                // some drivers. The SDK's TxFee type is `string | number`
                // post-3.1.0, so coerce to `number` (pre-fork wire shape) at
                // the boundary to keep callers bit-identical to pre-bump.
                network_fee: fromEntityToWireNumber(rawTx.networkFee),
                rpc_fee: fromEntityToWireNumber(rawTx.rpcFee),
                additional_fee: fromEntityToWireNumber(rawTx.additionalFee),
                // DEM-665: rpc_address is plain varchar — no numeric
                // coercion. `?? null` normalises undefined (an older
                // RawTransaction without the field) to the explicit
                // `null` declared by TxFee.
                rpc_address:
                    (rawTx as { rpcAddress?: string | null }).rpcAddress ??
                    null,
            },

            data: JSON.parse(rawTx.content).data,
            gcr_edits: JSON.parse(rawTx.content).gcr_edits,
        }
        tx.ed25519_signature = rawTx.ed25519_signature

        return tx
    }
}

/**
 * Coerce a wire-shape amount/fee value (`string | number | bigint | null`)
 * to a `bigint` suitable for the TypeORM `bigint` columns on the
 * `Transactions` entity.
 *
 * P5a boundary helper. The SDK's `RawTransaction`/`TransactionContent`
 * widened these fields to `string | number` (dual-format wire shape) but
 * the entity columns are `bigint`. TypeORM's runtime would accept either
 * shape, but the static type declares `bigint`, so we coerce explicitly
 * here to keep the typecheck honest. `null`/`undefined` map to `0n` to
 * match the zero-fee/zero-amount path that genesis and value-less
 * transactions have always relied on.
 */
function toEntityBigint(
    value: string | number | bigint | null | undefined,
): bigint {
    if (value === null || value === undefined) {
        return 0n
    }
    if (typeof value === "bigint") {
        return value
    }
    return BigInt(value)
}

/**
 * Coerce an entity-shape amount/fee value back to the legacy wire shape
 * (`number`) that downstream node code consumed pre-bump.
 *
 * P5a boundary helper. The TypeORM `bigint` columns surface as `string`
 * (Postgres) or `bigint` (some drivers) at the JS level; the SDK's
 * `TransactionContent.amount` and `TxFee.*` were widened to `string |
 * number` in 3.1.0. We narrow back to `number` here to preserve the
 * pre-bump observable behavior — the serializerGate is the single
 * choke-point that converts to OS strings post-fork.
 *
 * **Fail-loud bound (myc#77, GH#3213223281, GH#3213220462, GH#3215...
 * post-iter-5)**: post-fork OS amounts > `Number.MAX_SAFE_INTEGER`
 * (≈ 9.007e15 OS = ~9.007M DEM) cannot be represented as a JS `number`
 * without precision loss; a silent `Number(big)` cast would round to
 * the nearest double-precision value — corrupting amounts that flow
 * through `fromRawTransaction` into `tx.content.amount` and
 * `transaction_fee.*`. Throwing here surfaces a wire-shape mismatch
 * (pre-fork wire never carries OS-magnitude amounts; a post-fork value
 * showing up at this code path indicates a missing canonicalization
 * upstream).
 */
function fromEntityToWireNumber(
    value: string | number | bigint | null | undefined,
): number | string {
    if (value === null || value === undefined) {
        return 0
    }
    const big: bigint =
        typeof value === "bigint" ? value : BigInt(value as string | number)
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    // Post-fork: OS-magnitude amounts exceed `Number.MAX_SAFE_INTEGER`
    // (~9.007e15 OS = ~9.007M DEM). Coerce to a decimal string instead
    // of throwing — the SDK's `TxFee.{network_fee,rpc_fee,additional_fee}`
    // and `TransactionContent.amount` are typed `string | number` since
    // 3.1.0, so the string shape is wire-legal and lossless.
    //
    // The previous behaviour (throw on overflow) was inherited from
    // pre-fork days when this helper only ever saw DEM-magnitude values.
    // After the osDenomination fork activates, every persisted amount
    // is in OS — and any post-fork chain that ever processes a transfer
    // big enough to need OS precision (a 10 % move out of a founder
    // wallet pre-funded with 10^18 DEM = 10^27 OS, for instance) would
    // hit this throw on every `getTransactionStatus` poll, exactly the
    // path the SDK's `broadcastAndWait` walks while waiting for
    // inclusion. The polling caller then sees an HTTP 500 envelope,
    // never observes `state: "included"`, and times out — even though
    // the tx is on chain. Returning a string instead lets the SDK keep
    // parsing the response and observing the correct lifecycle state.
    if (big > max || big < -max) {
        return big.toString()
    }
    return Number(big)
}

/**
 * Convert a wire-shape `RawTransaction` (as produced by
 * {@link Transaction.toRawTransaction}) into a `Transactions` entity row
 * ready for TypeORM `save()`.
 *
 * P5a boundary helper. SDK 3.1.0 widened `RawTransaction.amount` and
 * fee fields to `string | number`, but the TypeORM entity columns are
 * `bigint`. Runtime behaviour is unchanged (TypeORM accepted the wire
 * shape implicitly before the SDK bump); this helper only narrows the
 * static types so `entityManager.save()` typechecks.
 *
 * @param rawTx - Wire-shape transaction record.
 * @returns Entity-shape transaction row (`bigint` amount and fees).
 */
export function toTransactionsEntity(rawTx: RawTransaction): Transactions {
    return {
        ...rawTx,
        amount: toEntityBigint(rawTx.amount),
        networkFee: toEntityBigint(rawTx.networkFee),
        rpcFee: toEntityBigint(rawTx.rpcFee),
        additionalFee: toEntityBigint(rawTx.additionalFee),
        // `nonce` on the entity is typed `number` while the SDK's
        // `RawTransaction.nonce` is `number`; pass through.
    }
}
