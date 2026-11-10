import { describe, expect, it } from "@jest/globals"
import {
    Keypair,
    MessageV0,
    PublicKey,
    Transaction,
    TransactionInstruction,
    VersionedTransaction,
} from "@solana/web3.js"
import bs58 from "bs58"

import {
    COMPUTE_BUDGET_PROGRAM_ID,
    LIGHTHOUSE_PROGRAM_ID,
    MEMO_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    associatedTokenAddress,
    buildProofTransaction,
    decodeProofTransaction,
    normalizeDemosAddress,
    proofXmScript,
    transferCheckedData,
} from "@/features/staking/proofBytes"

const owner = Keypair.generate()
const stranger = Keypair.generate()
const mint = Keypair.generate().publicKey
const DEMOS = "0x" + "ab".repeat(32)
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7))

function proof(over: Partial<Parameters<typeof buildProofTransaction>[0]> = {}): Transaction {
    return buildProofTransaction({
        owner: owner.publicKey,
        mint,
        tokenAccount: associatedTokenAddress(owner.publicKey, mint),
        demosAddress: DEMOS,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
        ...over,
    })
}

function signed(tx: Transaction, signer: Keypair = owner): Uint8Array {
    tx.sign(signer)
    return tx.serialize()
}

function decodeOk(bytes: Uint8Array) {
    const result = decodeProofTransaction(bytes)
    if (!result.ok) throw new Error(`expected a valid proof, got: ${result.reason}`)
    return result.proof
}

function reason(bytes: Uint8Array): string {
    const result = decodeProofTransaction(bytes)
    if (result.ok) throw new Error("expected a rejection")
    return result.reason
}

describe("decodeProofTransaction", () => {
    it("accepts a signed self-transfer with the memo and reads it back", () => {
        const tx = proof()
        const bytes = signed(tx)
        const decoded = decodeOk(bytes)
        expect(decoded.owner).toBe(owner.publicKey.toBase58())
        expect(decoded.mint).toBe(mint.toBase58())
        expect(decoded.tokenAccount).toBe(associatedTokenAddress(owner.publicKey, mint).toBase58())
        expect(decoded.tokenProgram).toBe(TOKEN_PROGRAM_ID.toBase58())
        expect(decoded.demosAddress).toBe(DEMOS)
        expect(decoded.recentBlockhash).toBe(BLOCKHASH)
        expect(decoded.signature).toBe(bs58.encode(tx.signature as Buffer))
    })

    it("accepts a Token-2022 account and an uppercase memo address without 0x", () => {
        const account = associatedTokenAddress(owner.publicKey, mint, TOKEN_2022_PROGRAM_ID)
        const decoded = decodeOk(
            signed(proof({ tokenAccount: account, tokenProgram: TOKEN_2022_PROGRAM_ID, demosAddress: "AB".repeat(32) })),
        )
        expect(decoded.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58())
        expect(decoded.demosAddress).toBe(DEMOS)
    })

    it("rejects an unsigned transaction", () => {
        const bytes = proof().serialize({ requireAllSignatures: false, verifySignatures: false })
        expect(reason(bytes)).toMatch(/not signed/)
    })

    it("rejects a tampered message", () => {
        const bytes = Uint8Array.from(signed(proof()))
        bytes[bytes.length - 1] ^= 0x01
        expect(reason(bytes)).toMatch(/does not verify/)
    })

    it("rejects a signature by a key other than the authority", () => {
        const tx = proof()
        tx.feePayer = stranger.publicKey
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        const partial = Transaction.from(bytes)
        partial.partialSign(stranger)
        expect(reason(partial.serialize({ requireAllSignatures: false }))).toMatch(/exactly one signer|authority is not the signer|not signed/)
    })

    it("rejects a transfer to another account", () => {
        const tx = proof()
        tx.instructions[0].keys[2].pubkey = associatedTokenAddress(stranger.publicKey, mint)
        expect(reason(signed(tx))).toMatch(/source and destination differ/)
    })

    it("rejects an amount other than one or decimals other than zero", () => {
        for (const patch of [{ offset: 1, value: 2 }, { offset: 9, value: 1 }]) {
            const tx = proof()
            const data = transferCheckedData()
            data[patch.offset] = patch.value
            tx.instructions[0].data = data
            expect(reason(signed(tx))).toMatch(/TransferChecked of amount 1/)
        }
    })

    it("accepts the compute budget and Lighthouse instructions a wallet adds when signing", () => {
        const tx = new Transaction({ feePayer: owner.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1000 })
        tx.add(
            new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from([2, 0x40, 0x0d, 3, 0]) }),
            new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) }),
            ...proof().instructions,
            new TransactionInstruction({
                programId: LIGHTHOUSE_PROGRAM_ID,
                keys: [{ pubkey: associatedTokenAddress(owner.publicKey, mint), isSigner: false, isWritable: false }],
                data: Buffer.from([7, 1, 2, 3]),
            }),
        )
        const decoded = decodeOk(signed(tx))
        expect(decoded.mint).toBe(mint.toBase58())
        expect(decoded.demosAddress).toBe(DEMOS)
    })

    it("rejects a second memo, a second transfer, or an instruction for any other program", () => {
        const secondMemo = proof().add(
            new TransactionInstruction({
                programId: MEMO_PROGRAM_ID,
                keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: false }],
                data: Buffer.from("second memo"),
            }),
        )
        expect(reason(signed(secondMemo))).toMatch(/exactly one Memo instruction, got 2/)
        const secondTransfer = proof()
        secondTransfer.add(secondTransfer.instructions[0])
        expect(reason(signed(secondTransfer))).toMatch(/exactly one SPL Token instruction, got 2/)
        const stranger = Keypair.generate().publicKey
        const unknown = proof().add(new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.from([1]) }))
        expect(reason(signed(unknown))).toMatch(new RegExp(`instruction for ${stranger.toBase58()}`))
    })

    it("rejects a memo that names no Demos address", () => {
        const tx = proof()
        tx.instructions[1].data = Buffer.from("demos-validator:0x1234")
        expect(reason(signed(tx))).toMatch(/does not name a Demos address/)
        const other = proof()
        other.instructions[1].data = Buffer.from("hello")
        expect(reason(signed(other))).toMatch(/does not start with demos-validator:/)
    })

    it("rejects a versioned transaction", () => {
        const message = MessageV0.compile({
            payerKey: owner.publicKey,
            recentBlockhash: BLOCKHASH,
            instructions: proof().instructions,
        })
        const versioned = new VersionedTransaction(message)
        versioned.sign([owner])
        expect(reason(versioned.serialize())).toMatch(/legacy|signer|decode/)
    })

    it("rejects empty and oversized input", () => {
        expect(reason(new Uint8Array())).toMatch(/empty/)
        expect(reason(new Uint8Array(2000))).toMatch(/bytes/)
    })
})

describe("normalizeDemosAddress", () => {
    it("lowercases and prefixes", () => {
        expect(normalizeDemosAddress(" AB".repeat(1) + "ab".repeat(31) + " ")).toBe(DEMOS)
        expect(normalizeDemosAddress(DEMOS.toUpperCase())).toBe(DEMOS)
        expect(normalizeDemosAddress("0x12")).toBeNull()
        expect(normalizeDemosAddress("zz".repeat(32))).toBeNull()
    })
})

describe("proofXmScript", () => {
    it("wraps the bytes as one Solana pay operation with no RPC and reads the signature back after JSON", () => {
        const tx = proof()
        const bytes = signed(tx)
        const script = proofXmScript(bytes)
        const [id] = script.operations_order as string[]
        const operation = (script.operations as Record<string, { chain: string; rpc: string; task: { type: string } }>)[id]
        expect(operation.chain).toBe("solana")
        expect(operation.rpc).toBe("")
        expect(operation.task.type).toBe("pay")
        expect(new PublicKey(decodeOk(bytes).owner).equals(owner.publicKey)).toBe(true)
    })
})
