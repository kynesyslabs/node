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

import forge from "node-forge"

import {
    RawTransaction,
    Transaction as ITransaction,
} from "@kynesyslabs/demosdk/types"
import type { ISignature } from "@kynesyslabs/demosdk/types"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import Confirmation from "./types/confirmation"
import { forgeToHex } from "../crypto/forgeUtils"
import log from "src/utilities/logger"

interface TransactionResponse {
    status: string
    code: number
    message: string
    data: {}
}

export default class Transaction implements ITransaction {
    content: TransactionContent
    signature: ISignature
    hash: string
    status: string
    blockNumber: number

    constructor() {
        this.content = {
            type: null,
            from: null,
            to: null,
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
        }
        this.signature = null
        this.hash = null
        this.status = null
    }

    // INFO Given a transaction, sign it with the private key of the sender
    public static sign(
        tx: Transaction,
        privateKey: forge.pki.ed25519.BinaryBuffer,
    ): [boolean, any] {
        // Check sanity of the structure of the tx object
        if (!tx.content) {
            return [false, "Missing tx.content"]
        }
        // Sign using identity.cryptography.sign(tx.content, privateKey)
        const signature = Cryptography.sign(
            JSON.stringify(tx.content),
            privateKey,
        )
        if (!signature) {
            return [false, "Failed to sign transaction"]
        }
        return [true, signature]
    }

    // INFO Given a signed transaction, verify it against the address of the sender
    // Returns [result, message]
    static verify(tx: Transaction) {
        // Check sanity of the structure of the tx object
        if (!tx.content) {
            return [false, "Missing tx.content"]
        }
        if (!tx.signature) {
            return [false, "Missing tx.signature"]
        }
        // verify using identity.cryptography.verify(tx.content, tx.signature, publicKey)
        const verified = Cryptography.verify(
            JSON.stringify(tx.content),
            tx.signature.data.toString("hex"),
            tx.content.from.toString("hex"),
        )
        return [verified, "Result of verify()"]
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
    static confirmTx(
        tx: Transaction,
        publicKey: forge.pki.ed25519.BinaryBuffer,
        privateKey: forge.pki.ed25519.BinaryBuffer,
    ) {
        console.log("[TRANSACTION]: confirmTx")
        console.log("Public key: ")
        console.log(publicKey)
        console.log("Private key: ")
        console.log(privateKey)
        console.log("Signature: ")
        console.log(tx.signature)
        const structured = this.structured(tx)
        if (!structured.valid) {
            return null // TODO Improve return type
        }
        const confirmed = this.validateSignature(tx) && this.isCoherent(tx)
        if (confirmed) {
            const confirmation = new Confirmation()
            confirmation.data.validator = publicKey
            confirmation.data.tx_hash_validated = tx.hash
            confirmation.signature = Cryptography.sign(
                JSON.stringify(confirmation.data),
                privateKey,
            ).toString()
            return confirmation
        } else {
            return null
        }
    }

    // INFO Checks the integrity of a transaction
    public static validateSignature(tx: Transaction) {
        console.log("[validateSignature] Checking the signature of the tx")
        console.log("Hash: " + tx.hash)
        console.log("Signature: ")
        console.log(forgeToHex(tx.signature.data))
        console.log("From: ")
        console.log(forgeToHex(tx.content.from))
        //let tx_content_hash = Hashing.sha256(JSON.stringify(tx.content))
        const result = Cryptography.verify(
            tx.hash,
            forgeToHex(tx.signature.data),
            forgeToHex(tx.content.from),
        )
        console.log("[validateSignature] Sanity: " + result)
        return result
    }

    // INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
    public static isCoherent(tx: Transaction) {
        console.log(
            "[isCoherent] Checking the coherence of the tx with hash: " +
                tx.hash,
        )
        const derivedHash = Hashing.sha256(JSON.stringify(tx.content))
        console.log("[isCoherent] Derived hash: " + derivedHash)
        const coherence = derivedHash == tx.hash
        console.log("[isCoherent] Coherence: " + coherence)
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
        console.log("[validateToField] Validating TO field")
        console.log(to)

        // Step 1: Check if the field exists
        if (!to) {
            console.log("[validateToField] Missing TO field")
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
                console.log(
                    `[validateToField] TO field must be exactly 32 bytes (received ${toBuffer.length} bytes)`,
                )
                return {
                    valid: false,
                    message: `TO field must be exactly 32 bytes (received ${toBuffer.length} bytes)`,
                }
            }

            // Step 4: Validate as Ed25519 public key
            // We'll just verify it's a 32-byte buffer, which is the correct size for a raw Ed25519 public key
            // NOTE: any 32-byte buffer is a valid Ed25519 public key (not just the ones generated by forge)
            console.log(
                "[validateToField] TO field is a valid Ed25519 public key format",
            )

            // All validations passed
            return {
                valid: true,
                message: "TO field is valid",
            }
        } catch (e) {
            console.log("[validateToField] Error validating TO field:", e)
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
                    console.warn(
                        "[validateToField] Warning: Hex string should start with '0x' prefix for consistency",
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
            console.log("[validateToField] TO field is not in a valid format")
            return null
        } catch (e) {
            console.log(
                "[validateToField] Error converting TO field to Buffer:",
                e,
            )
            return null
        }
    }
    // Modify the structured method to use the new validation
    public static structured(tx: Transaction): {
        valid: boolean
        message: string
    } {
        // Validate TO field
        const toValidation = this.validateToField(tx.content.to)
        if (!toValidation.valid) {
            return {
                valid: false,
                message: toValidation.message,
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
        console.log("[toRawTransaction] attempting to create a raw tx")
        console.log("[toRawTransaction] Signature: ")
        console.log(tx.signature.data)
        console.log("[toRawTransaction] Block number: " + tx.blockNumber)
        console.log("[toRawTransaction] Status: " + status)
        console.log("[toRawTransaction] Hash: " + tx.hash)
        console.log("[toRawTransaction] Type: " + tx.content.type)

        // NOTE From and To can be either a string or a Buffer
        if (tx.content.to["data"]?.toString("hex")) {
            tx.content.to = tx.content.to["data"]?.toString("hex")
        }
        if (tx.content.from["data"]?.toString("hex")) {
            tx.content.from = tx.content.from["data"]?.toString("hex")
        }

        console.log("[toRawTransaction] From: " + tx.content.from)
        console.log("[toRawTransaction] To: " + tx.content.to)
        const rawTx = {
            blockNumber: tx.blockNumber,
            signature: JSON.stringify(tx.signature.data), // REVIEW This is a horrible thing, if it even works
            status: status,
            hash: tx.hash,
            content: JSON.stringify(tx.content),
            type: tx.content.type,
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
        console.log(
            "[fromRawTransaction] Attempting to create a transaction from a raw transaction with hash: " +
                rawTx.hash,
        )
        const tx = new Transaction()

        console.log(rawTx)

        tx.blockNumber = rawTx.blockNumber
        tx.signature = {
            type: "ed25519", // Assuming the signature type as ed25519; adjust accordingly
            data: Buffer.from(rawTx.signature, "hex"),
        }
        tx.status = rawTx.status
        tx.hash = rawTx.hash
        tx.content = {
            type: rawTx.type as
                | "web2Request"
                | "crosschainOperation"
                | "demoswork" // ! Remove this horrible thing when possible
                | "NODE_ONLINE",
            from: Buffer.from(rawTx.from, "hex"),
            to: Buffer.from(rawTx.to, "hex"),
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
        return tx
    }
}
