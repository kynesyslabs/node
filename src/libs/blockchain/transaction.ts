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
import type { ISignature, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import Hashing from "../crypto/hashing"
import Confirmation from "./types/confirmation"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "@/utilities/sharedState"
import IdentityManager from "./gcr/gcr_routines/identityManager"
import { SavedPqcIdentity } from "@/model/entities/types/IdentityTypes"
import log from "src/utilities/logger"

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
    status: string | null = null
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
    public static async sign(tx: Transaction): Promise<[boolean, any]> {
        // Check sanity of the structure of the tx object
        if (!tx.content) {
            return [false, "Missing tx.content"]
        }
        const signature_ = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(JSON.stringify(tx.content)),
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
    static hash(tx: Transaction): any {
        const hash = Hashing.sha256(JSON.stringify(tx.content))
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
        log.debug(`[TX] confirmTx - Signature: ${JSON.stringify(tx.signature)}`)
        const structured = this.structured(tx)
        if (!structured.valid) {
            return null // TODO Improve return type
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
        const signature = await ucrypto.sign(
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
        log.debug(
            `[TX] validateSignature - Hash: ${tx.hash}, From: ${tx.content.from}, Signature: ${JSON.stringify(tx.signature)}`,
        )

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

        let ed25519SignatureVerified = false

        // INFO: If a PQC signer is used, make sure identity is in the GCR
        // or there's an ed25519 signature to verify ownership of ed25519 address
        if (tx.signature.type !== "ed25519") {
            // INFO: check if sender's PQC pubkey is indexed in the GCR
            if (!tx.ed25519_signature) {
                const identities =
                    (await IdentityManager.getIdentities(
                        tx.content.from_ed25519_address,
                        "pqc",
                    )) || {}

                // INFO: Get all the indexed pubkeys for the PQC signer type (eg. falcon, etc.)
                const indexedPubKeys: SavedPqcIdentity[] =
                    identities[tx.signature.type] || []

                // INFO: Check if sender's PQC pubkey is indexed in PQC identities
                const found = indexedPubKeys.find(
                    identity => identity.address === tx.content.from,
                )

                if (!found) {
                    return {
                        success: false,
                        message:
                            "Transaction is missing ed25519 signature, and the PQC signer is not added as an identity. Please provide an ed25519 signature or add the PQC signer as an identity for " +
                            tx.content.from_ed25519_address,
                    }
                }

                // Verify the found key's signature with the tx's ed25519 address
                ed25519SignatureVerified = await ucrypto.verify({
                    algorithm: "ed25519",
                    message: new TextEncoder().encode(found.address),
                    publicKey: hexToUint8Array(tx.content.from_ed25519_address),
                    signature: hexToUint8Array(found.signature),
                })
            } else {
                // INFO: Verify ed25519 signature
                ed25519SignatureVerified = await ucrypto.verify({
                    algorithm: "ed25519",
                    message: new TextEncoder().encode(tx.hash),
                    publicKey: hexToUint8Array(tx.content.from_ed25519_address),
                    signature: hexToUint8Array(tx.ed25519_signature),
                })
            }
        } else {
            ed25519SignatureVerified = true
        }

        if (!ed25519SignatureVerified) {
            return {
                success: false,
                message: "Ed25519 signature verification failed",
            }
        }

        const mainSignatureVerified = await ucrypto.verify({
            algorithm: tx.signature.type as SigningAlgorithm,
            message: new TextEncoder().encode(tx.hash),
            publicKey: hexToUint8Array(tx.content.from as string),
            signature: hexToUint8Array(tx.signature.data),
        })

        return {
            success: mainSignatureVerified,
            message: mainSignatureVerified
                ? "Transaction signature verified"
                : "Transaction signature verification failed",
        }
    }

    // INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
    public static isCoherent(tx: Transaction) {
        log.debug(`[TX] isCoherent - Checking coherence of tx hash: ${tx.hash}`)
        const derivedHash = Hashing.sha256(JSON.stringify(tx.content))
        log.debug(
            `[TX] isCoherent - Derived hash: ${derivedHash}, Coherence: ${derivedHash === tx.hash}`,
        )
        const coherence = derivedHash === tx.hash
        return coherence
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
        log.debug(
            `[TX] validateToField - Validating TO field: ${JSON.stringify(to)}`,
        )

        // Step 1: Check if the field exists
        if (!to) {
            log.debug("[TX] validateToField - Missing TO field")
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
                log.debug(
                    `[TX] validateToField - TO field must be exactly 32 bytes (received ${toBuffer.length} bytes)`,
                )
                return {
                    valid: false,
                    message: `TO field must be exactly 32 bytes (received ${toBuffer.length} bytes)`,
                }
            }

            // Step 4: Validate as Ed25519 public key
            // We'll just verify it's a 32-byte buffer, which is the correct size for a raw Ed25519 public key
            // NOTE: any 32-byte buffer is a valid Ed25519 public key (not just the ones generated by forge)
            log.debug(
                "[TX] validateToField - TO field is a valid Ed25519 public key format",
            )

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
                message: `Error validating TO field: ${e instanceof Error ? e.message : String(e)
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
        log.debug(
            `[TX] validateStorageAddress - Validating storage address: ${to}`,
        )

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

    public static toRawTransaction(
        tx: Transaction,
        status = "confirmed",
    ): RawTransaction {
        log.debug(
            `[TX] toRawTransaction - Creating raw tx: hash=${tx.hash}, type=${tx.content.type}, status=${status}, blockNumber=${tx.blockNumber}`,
        )

        // NOTE From and To can be either a string or a Buffer
        if (tx.content.to["data"]?.toString("hex")) {
            tx.content.to = tx.content.to["data"]?.toString("hex")
        }
        if (tx.content.from["data"]?.toString("hex")) {
            tx.content.from = tx.content.from["data"]?.toString("hex")
        }

        log.debug(
            `[TX] toRawTransaction - From: ${tx.content.from}, To: ${tx.content.to}`,
        )
        const rawTx = {
            blockNumber: tx.blockNumber,
            signature: JSON.stringify(tx.signature), // REVIEW This is a horrible thing, if it even works
            ed25519_signature: tx.ed25519_signature,
            status: status,
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
            id: 0, // ? What is this?
        }

        return rawTx
    }

    public static fromRawTransaction(rawTx: RawTransaction): Transaction {
        if (!rawTx) {
            return null
        }

        log.debug(
            `[fromRawTransaction] Creating transaction from raw with hash: ${rawTx.hash}`,
        )
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
            amount: rawTx.amount,
            nonce: rawTx.nonce,
            timestamp: rawTx.timestamp,
            transaction_fee: {
                network_fee: rawTx.networkFee,
                rpc_fee: rawTx.rpcFee,
                additional_fee: rawTx.additionalFee,
            },

            data: JSON.parse(rawTx.content).data,
            gcr_edits: JSON.parse(rawTx.content).gcr_edits,
        }
        tx.ed25519_signature = rawTx.ed25519_signature

        return tx
    }
}
