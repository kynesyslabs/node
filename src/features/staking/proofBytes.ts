// The validator NFT proof as raw Solana transaction bytes: building one and
// checking that a submitted one is signed, well-formed and names a Demos
// address. Depends on web3.js only, so the CLI shares it with the node.
import {
    PublicKey,
    Transaction,
    TransactionInstruction,
} from "@solana/web3.js"
import type { XMScript } from "@kynesyslabs/demosdk/types"
import bs58 from "bs58"

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
export const MEMO_PROGRAM_IDS = new Set([
    MEMO_PROGRAM_ID.toBase58(),
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
])
export const PROOF_MEMO_PREFIX = "demos-validator:"

/** Largest proof transaction accepted; a real one is about 400 bytes. */
export const MAX_PROOF_BYTES = 1232

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()])
const TRANSFER_CHECKED = 12

/**
 * Programs a wallet may add around the proof when it signs: compute budget
 * for priority fees, and Lighthouse, Phantom's post-state guard. Neither
 * moves anything. Every other program is refused.
 */
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111")
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95")
const WALLET_ADDED_PROGRAMS = new Set([COMPUTE_BUDGET_PROGRAM_ID.toBase58(), LIGHTHOUSE_PROGRAM_ID.toBase58()])

export interface DecodedProof {
    /** Base58 signature of the transaction, as Solana will record it. */
    signature: string
    /** The wallet that signed, pays the fee and owns the token account. */
    owner: string
    mint: string
    tokenAccount: string
    tokenProgram: string
    /** The Demos address the memo names, lowercase with 0x. */
    demosAddress: string
    recentBlockhash: string
}

export type DecodeResult =
    | { ok: true; proof: DecodedProof }
    | { ok: false; reason: string }

function bad(reason: string): DecodeResult {
    return { ok: false, reason }
}

/** `TransferChecked` of one unit, decimals 0: the instruction data a proof carries. */
export function transferCheckedData(): Buffer {
    const data = Buffer.alloc(10)
    data.writeUInt8(TRANSFER_CHECKED, 0)
    data.writeBigUInt64LE(1n, 1)
    data.writeUInt8(0, 9)
    return data
}

export function associatedTokenAddress(
    owner: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
    const [address] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return address
}

export interface ProofTransactionInput {
    owner: PublicKey
    mint: PublicKey
    tokenAccount: PublicKey
    tokenProgram?: PublicKey
    demosAddress: string
    blockhash: string
    lastValidBlockHeight: number
}

/** The unsigned proof: a self `TransferChecked` of the NFT plus the memo. */
export function buildProofTransaction(input: ProofTransactionInput): Transaction {
    const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID
    const transfer = new TransactionInstruction({
        programId: tokenProgram,
        keys: [
            { pubkey: input.tokenAccount, isSigner: false, isWritable: true },
            { pubkey: input.mint, isSigner: false, isWritable: false },
            { pubkey: input.tokenAccount, isSigner: false, isWritable: true },
            { pubkey: input.owner, isSigner: true, isWritable: false },
        ],
        data: transferCheckedData(),
    })
    const memo = new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: input.owner, isSigner: true, isWritable: false }],
        data: Buffer.from(`${PROOF_MEMO_PREFIX}${normalizeDemosAddress(input.demosAddress)}`, "utf8"),
    })
    return new Transaction({
        feePayer: input.owner,
        blockhash: input.blockhash,
        lastValidBlockHeight: input.lastValidBlockHeight,
    }).add(transfer, memo)
}

/** Lowercase 0x form of a Demos address, or null when it is not one. */
export function normalizeDemosAddress(address: string): string | null {
    const lower = address.trim().toLowerCase()
    const hex = lower.startsWith("0x") ? lower.slice(2) : lower
    return /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : null
}

/**
 * Decodes signed proof bytes and checks them without touching the network:
 * one signer whose ed25519 signature verifies over the message, exactly one
 * self `TransferChecked` of one unit with decimals 0 authorised by that
 * signer, one memo naming a Demos address, and nothing else beyond what a
 * wallet adds for fees or its own guard.
 */
export function decodeProofTransaction(bytes: Uint8Array): DecodeResult {
    if (bytes.length === 0) return bad("transaction is empty")
    if (bytes.length > MAX_PROOF_BYTES) return bad(`transaction is ${bytes.length} bytes; a proof is under ${MAX_PROOF_BYTES}`)
    let tx: Transaction
    try {
        tx = Transaction.from(bytes)
    } catch (e) {
        return bad(`transaction does not decode as a legacy Solana transaction: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (tx.signatures.length !== 1) return bad(`proof must have exactly one signer, got ${tx.signatures.length}`)
    const [{ signature, publicKey: signer }] = tx.signatures
    if (signature === null) return bad("proof is not signed")
    if (!tx.feePayer || !tx.feePayer.equals(signer)) return bad("proof fee payer is not the signer")
    if (!tx.recentBlockhash) return bad("proof has no recent blockhash")
    try {
        if (!tx.verifySignatures(true)) return bad("proof signature does not verify")
    } catch (e) {
        return bad(`proof signature does not verify: ${e instanceof Error ? e.message : String(e)}`)
    }
    const transfers = tx.instructions.filter(ix => TOKEN_PROGRAMS.has(ix.programId.toBase58()))
    const memos = tx.instructions.filter(ix => MEMO_PROGRAM_IDS.has(ix.programId.toBase58()))
    const others = tx.instructions.filter(
        ix =>
            !TOKEN_PROGRAMS.has(ix.programId.toBase58()) &&
            !MEMO_PROGRAM_IDS.has(ix.programId.toBase58()) &&
            !WALLET_ADDED_PROGRAMS.has(ix.programId.toBase58()),
    )
    if (transfers.length !== 1) return bad(`proof must carry exactly one SPL Token instruction, got ${transfers.length}`)
    if (memos.length !== 1) return bad(`proof must carry exactly one Memo instruction, got ${memos.length}`)
    if (others.length > 0) {
        return bad(`proof carries an instruction for ${others[0].programId.toBase58()}; only compute budget and Lighthouse may be added`)
    }
    const [transfer] = transfers
    const [memo] = memos

    if (!Buffer.from(transfer.data).equals(transferCheckedData())) {
        return bad("token instruction is not TransferChecked of amount 1 with 0 decimals")
    }
    if (transfer.keys.length < 4) return bad("TransferChecked needs four accounts")
    const [source, mint, destination, authority] = transfer.keys
    if (!source.pubkey.equals(destination.pubkey)) return bad("TransferChecked source and destination differ; the NFT must stay put")
    if (!authority.pubkey.equals(signer)) return bad("TransferChecked authority is not the signer")
    if (!authority.isSigner) return bad("TransferChecked authority is not marked as a signer")
    if (transfer.keys.length > 4) return bad("TransferChecked with multisig signers is not a proof")

    const text = Buffer.from(memo.data).toString("utf8")
    if (!text.startsWith(PROOF_MEMO_PREFIX)) return bad(`memo does not start with ${PROOF_MEMO_PREFIX}`)
    const demosAddress = normalizeDemosAddress(text.slice(PROOF_MEMO_PREFIX.length))
    if (demosAddress === null) return bad("memo does not name a Demos address")
    if (!memo.keys.some(k => k.isSigner && k.pubkey.equals(signer))) return bad("memo is not signed by the wallet")

    return {
        ok: true,
        proof: {
            signature: bs58.encode(signature),
            owner: signer.toBase58(),
            mint: mint.pubkey.toBase58(),
            tokenAccount: source.pubkey.toBase58(),
            tokenProgram: transfer.programId.toBase58(),
            demosAddress,
            recentBlockhash: tx.recentBlockhash,
        },
    }
}

/**
 * The XM script that records a signed proof on Demos: one Solana `pay`
 * operation whose payload is the signed bytes. `rpc` stays empty so the
 * executing node picks its own endpoint and no key enters chain data.
 */
export function proofXmScript(bytes: Uint8Array): XMScript {
    const id = crypto.randomUUID().replaceAll("-", "")
    return {
        operations: {
            [id]: {
                chain: "solana",
                subchain: "mainnet",
                is_evm: false,
                rpc: "",
                task: { type: "pay", signedPayloads: [Array.from(bytes)], params: null },
            },
        },
        operations_order: [id],
    } as unknown as XMScript
}
