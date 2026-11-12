/* eslint-disable no-console */
import "dotenv/config"
import { existsSync, readFileSync } from "node:fs"

import {
    Connection,
    Keypair,
    PublicKey,
    type ParsedTransactionWithMeta,
} from "@solana/web3.js"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"

import { parseNodeUrl } from "../src/config/nodeUrl"
import {
    MEMO_PROGRAM_IDS,
    PROOF_MEMO_PREFIX,
    associatedTokenAddress,
    buildProofTransaction,
    decodeProofTransaction,
} from "../src/features/staking/proofBytes"
import { ACCEPTED_SECRET_FORMATS, loadSolanaSigner, type SolanaSigner } from "./solana-signer"

const PEERLIST_FILE = "demos_peerlist.json"
const DEFAULT_IDENTITY_FILE = ".demos_identity"
const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"

const CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 3_000
const SOLANA_FINALITY_TIMEOUT_MS = 180_000
const SOLANA_POLL_INTERVAL_MS = 5_000

// Global context: parsed flags shared across every sub-command.
interface ValidatorContext {
    identity: string
    rpc: string
    solanaRpc: string
    flags: Record<string, string>
}

declare global {
    // eslint-disable-next-line no-var
    var validatorCtx: ValidatorContext
}

// ---------- small helpers ----------

function exitWith(msg: string, code = 1): never {
    console.error(msg)
    process.exit(code)
}

const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`
const purple = (s: string): string => `\x1b[35m${s}\x1b[0m`

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

function parseArgs(argv: string[]): {
    positionals: string[]
    flags: Record<string, string>
} {
    const positionals: string[] = []
    const flags: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg.startsWith("--")) {
            const key = arg.slice(2)
            const next = argv[i + 1]
            if (next === undefined || next.startsWith("--")) {
                flags[key] = "true"
            } else {
                flags[key] = next
                i++
            }
        } else {
            positionals.push(arg)
        }
    }
    return { positionals, flags }
}

function firstPeerlistRpc(): string {
    if (!existsSync(PEERLIST_FILE)) {
        exitWith(
            `${PEERLIST_FILE} not found. Pass --rpc <url> or create the peerlist.`,
        )
    }
    let peers: Record<string, string>
    try {
        peers = JSON.parse(readFileSync(PEERLIST_FILE, "utf8"))
    } catch {
        exitWith(`failed to parse ${PEERLIST_FILE}`)
    }
    const urls = Object.values(peers)
    if (urls.length === 0) {
        exitWith(`${PEERLIST_FILE} has no entries. Pass --rpc <url>.`)
    }
    return urls[0]
}

function loadMnemonic(file: string): string {
    if (!existsSync(file)) {
        exitWith(`identity file not found: ${file}`)
    }
    const mnemonic = readFileSync(file, "utf8").trim()
    if (!mnemonic) {
        exitWith(`identity file is empty: ${file}`)
    }
    return mnemonic
}

async function connect(): Promise<Demos> {
    const { rpc, identity } = globalThis.validatorCtx
    const demos = new Demos()
    await demos.connect(rpc)
    await demos.connectWallet(loadMnemonic(identity))

    console.log("------------------------------------------")
    console.log(`Identity:        ${identity}`)
    console.log(`Node public key: ${demos.getAddress()}`)
    console.log(`Network:         ${rpc}`)
    console.log("------------------------------------------ \n")

    return demos
}

/**
 * Poll getTransactionStatus every 3s for up to 20s. Resolves to the terminal
 * status (`included`/`failed`) once observed, or null if the wait times out.
 */
async function waitForInclusion(
    demos: Demos,
    hash: string,
): Promise<{ state: string; blockNumber?: number } | null> {
    const start = Date.now()
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
        const res = await demos.call("nodeCall", "getTransactionStatus", {
            hash,
        })
        const state =
            res && typeof res === "object"
                ? (res as { state?: string }).state
                : undefined
        if (state === "included" || state === "failed") {
            return {
                state,
                blockNumber: (res as { blockNumber?: number }).blockNumber,
            }
        }
        await sleep(CONFIRM_POLL_INTERVAL_MS)
    }
    return null
}

/**
 * Confirm + broadcast a signed tx, print its hash and expected confirmation
 * block, then wait for on-chain inclusion.
 */
async function submit(
    demos: Demos,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    label: string,
): Promise<void> {
    console.log(`${label}... \n`)

    const validation = await demos.confirm(tx)
    const hash = validation?.response?.data?.transaction?.hash
    if (!hash) {
        const reason = validation?.response?.data?.message
        exitWith(
            reason
                ? `transaction rejected: ${reason}`
                : "could not extract transaction hash from confirmation",
        )
    }

    const result = await demos.broadcast(validation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let confirmationBlock = (result as any)?.extra?.confirmationBlock
    if (confirmationBlock == null) {
        // Fallback: the next block is the earliest possible inclusion point.
        confirmationBlock = (await demos.getLastBlockNumber()) + 1
    }

    console.log(`Tx Hash  :  ${purple(hash)}`)
    console.log(`Block No.:  ${confirmationBlock} \n`)

    console.log("Waiting for on-chain confirmation...")
    const status = await waitForInclusion(demos, hash)

    if (status?.state === "included") {
        console.log(
            green(`✅ confirmed: included in block ${status.blockNumber} \n`),
        )
    } else if (status?.state === "failed") {
        console.log(
            yellow(`⚠️  transaction reported failed on-chain: ${hash} \n`),
        )
    } else {
        console.log(
            yellow(
                `⚠️  confirmation timed out: tx ${hash} not found on the network. Please the transaction status manually. \n`,
            ),
        )
    }
}

// ---------- Solana helpers ----------

function solanaConnection(): Connection {
    return new Connection(globalThis.validatorCtx.solanaRpc, { commitment: "finalized" })
}

function loadSolanaKeypair(file: string): Keypair {
    const { flags } = globalThis.validatorCtx
    const account = flags.account === undefined ? 0 : Number(flags.account)
    let signer: SolanaSigner
    try {
        signer = loadSolanaSigner(file, { account, passphrase: flags.passphrase })
    } catch (e) {
        exitWith(e instanceof Error ? e.message : String(e))
    }
    const via = signer.derivationPath ? `${signer.kind} ${signer.derivationPath}` : signer.kind
    console.log(`Solana signer: ${signer.keypair.publicKey.toBase58()} (${via})`)
    return signer.keypair
}

/**
 * Sign the proof locally, send it to Solana, then wait for finality.
 * Returns the Solana signature.
 */
async function sendNftProof(
    keypair: Keypair,
    mint: PublicKey,
    demosAddress: string,
    demos: Demos,
): Promise<string> {
    const holder = (await demos.getValidatorByMint(mint.toBase58())) as { address?: string } | null
    if (holder?.address) {
        process.stderr.write(
            yellow(`mint ${mint.toBase58()} backs the seat of ${holder.address}; staking with this proof evicts it\n`),
        )
    }

    const connection = solanaConnection()
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
    if (decoded.ok === false) exitWith(`built proof does not pass the node's checks: ${decoded.reason}`)
    const signature = decoded.proof.signature

    console.log(`Proving NFT ${mint.toBase58()} for ${demosAddress}...`)
    try {
        await connection.sendRawTransaction(bytes)
    } catch (e) {
        exitWith(`Solana refused the proof: ${e instanceof Error ? e.message : String(e)}`)
    }
    console.log(`Solana signature: ${purple(signature)}`)

    console.log("Waiting for Solana finality...")
    const started = Date.now()
    while (Date.now() - started < SOLANA_FINALITY_TIMEOUT_MS) {
        const { value: [status] } = await connection.getSignatureStatuses([signature])
        if (status?.err) exitWith(`proof transaction failed on Solana: ${JSON.stringify(status.err)}`)
        if (status?.confirmationStatus === "finalized") {
            console.log(green("✅ proof finalized \n"))
            return signature
        }
        if (!status && (await connection.getBlockHeight()) > lastValidBlockHeight) {
            exitWith("the blockhash expired before the proof landed on Solana; run the command again")
        }
        await sleep(SOLANA_POLL_INTERVAL_MS)
    }
    console.log(yellow(`finality not seen after ${SOLANA_FINALITY_TIMEOUT_MS / 1000}s; verify ${signature} before staking`))
    return signature
}

interface DerivedProof {
    mint: string
    owner: string
    proofTx: string
    memoAddress: string | null
}

/** Read mint, owner, and memo back from a finalized proof transaction. */
async function derivedProof(signature: string): Promise<DerivedProof> {
    const connection = solanaConnection()
    let parsed: ParsedTransactionWithMeta | null
    try {
        parsed = await connection.getParsedTransaction(signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
        })
    } catch (e) {
        exitWith(`could not fetch proof ${signature}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (parsed === null) exitWith(`proof ${signature} is not finalized or not found`)
    if (parsed.meta?.err) exitWith(`proof ${signature} failed on Solana`)

    const signers = parsed.transaction.message.accountKeys
        .filter(key => key.signer)
        .map(key => key.pubkey.toBase58())
    const held = (parsed.meta?.postTokenBalances ?? []).filter(
        balance =>
            balance.uiTokenAmount.amount === "1" &&
            balance.owner !== undefined &&
            signers.includes(balance.owner),
    )
    if (held.length !== 1) {
        exitWith(
            `proof ${signature} must leave exactly one NFT with its signer; found ${held.length}`,
        )
    }
    let memoAddress: string | null = null
    for (const instruction of parsed.transaction.message.instructions) {
        if (!MEMO_PROGRAM_IDS.has(instruction.programId.toBase58())) continue
        const text = (instruction as { parsed?: unknown }).parsed
        if (typeof text === "string" && text.startsWith(PROOF_MEMO_PREFIX)) {
            memoAddress = text.slice(PROOF_MEMO_PREFIX.length).trim().toLowerCase()
        }
    }
    return {
        mint: held[0].mint,
        owner: held[0].owner as string,
        proofTx: signature,
        memoAddress,
    }
}

function sameAddress(a: string, b: string): boolean {
    const strip = (s: string) => s.toLowerCase().replace(/^0x/, "")
    return strip(a) === strip(b)
}

// ---------- commands ----------

async function cmdNftProof(): Promise<void> {
    const { flags } = globalThis.validatorCtx
    const mint = flags.mint
    const keypairFile = flags.keypair
    if (!mint) exitWith("usage: validator nft-proof --mint <MINT> --keypair <key file> [--account <n>] [--demos-address <0x...>]")
    if (!keypairFile) exitWith(`--keypair <key file> is required (${ACCEPTED_SECRET_FORMATS})`)
    const keypair = loadSolanaKeypair(keypairFile)
    const demos = await connect()
    const demosAddress = flags["demos-address"] ?? demos.getAddress()
    if (!sameAddress(demosAddress, demos.getAddress())) {
        console.log(
            yellow(`the memo names ${demosAddress}; the Demos record is signed by this identity ${demos.getAddress()}\n`),
        )
    }
    const signature = await sendNftProof(keypair, new PublicKey(mint), demosAddress, demos)
    console.log("Stake with:")
    console.log(`  bun run validator:stake --nft-proof ${signature}`)
}

async function cmdStake(): Promise<void> {
    const { flags } = globalThis.validatorCtx

    // The seat records this node's public URL, not the node the tx goes through.
    const connectionUrl = process.env.EXPOSED_URL?.trim() ?? ""
    if (!parseNodeUrl(connectionUrl)) {
        exitWith(
            `EXPOSED_URL in .env is "${connectionUrl}"; the stake records it as this validator's connection URL and it must be http(s)://host:port`,
        )
    }

    const demos = await connect()
    const address = demos.getAddress()

    // A new seat needs the NFT proof; a top-up carries none. The proof is
    // either passed as a finalized signature or produced here from a keypair.
    let proofTx = flags["nft-proof"]
    if (!proofTx && flags["solana-keypair"]) {
        if (!flags["nft-mint"]) exitWith("--nft-mint <MINT> is required with --solana-keypair")
        proofTx = await sendNftProof(
            loadSolanaKeypair(flags["solana-keypair"]),
            new PublicKey(flags["nft-mint"]),
            address,
            demos,
        )
    }

    let nft: { mint: string; owner: string; proofTx: string } | undefined
    if (proofTx) {
        const proof = await derivedProof(proofTx)
        if (proof.memoAddress === null) {
            exitWith(`proof ${proofTx} carries no ${PROOF_MEMO_PREFIX} memo`)
        }
        if (!sameAddress(proof.memoAddress, address)) {
            exitWith(
                `proof ${proofTx} names ${proof.memoAddress}, not this node's address ${address}`,
            )
        }
        nft = { mint: proof.mint, owner: proof.owner, proofTx }
        console.log(`NFT:    ${nft.mint}`)
        console.log(`Wallet: ${nft.owner}\n`)
    } else {
        console.log(yellow("No --nft-proof given: this only works to re-stake a seat this node already holds.\n"))
    }

    // A seat is backed by the NFT alone; the stake records no DEM.
    const tx = await DemosTransactions.stake("0", connectionUrl, demos, { nft })
    await submit(demos, tx, "Staking")
}

async function cmdUnstake(): Promise<void> {
    const demos = await connect()
    const tx = await DemosTransactions.unstake(demos)
    await submit(demos, tx, "Unstaking")
}

async function cmdExit(): Promise<void> {
    const demos = await connect()
    const tx = await DemosTransactions.validatorExit(demos)
    await submit(demos, tx, "Validator Exit")
}

async function cmdChallenge(): Promise<void> {
    const { flags } = globalThis.validatorCtx
    const validator = flags.validator
    const transfer = flags.transfer
    if (!validator || !transfer) {
        exitWith("usage: validator challenge --validator <0x...> --transfer <solana signature>")
    }
    const demos = await connect()
    const info = (await demos.getValidatorInfo(validator.toLowerCase())) as { nftProofTx?: string | null } | null
    if (!info?.nftProofTx) exitWith(`${validator} holds no seat backed by an NFT proof`)
    const tx = await DemosTransactions.challengeValidator(validator.toLowerCase(), transfer, info.nftProofTx, demos)
    await submit(demos, tx, `Challenging ${validator}`)
}

// ---------- entry point ----------

const USAGE =
    "usage: validator <nft-proof|stake|unstake|exit|challenge> " +
    "[--identity <file>] [--rpc <url>] [--solana-rpc <url>]\n" +
    "  nft-proof --mint <MINT> --keypair <key file> [--account <n>] [--demos-address <0x...>]\n" +
    "    signs the proof, sends it to Solana, waits for finality\n" +
    "  stake --nft-proof <signature>\n" +
    "  stake --nft-mint <MINT> --solana-keypair <key file> [--account <n>]\n" +
    `  key file: ${ACCEPTED_SECRET_FORMATS}; --account picks the mnemonic account index\n` +
    "  challenge --validator <0x...> --transfer <signature>"

async function main(): Promise<void> {
    const { positionals, flags } = parseArgs(process.argv.slice(2))
    const command = positionals[0]
    if (flags.amount !== undefined) {
        exitWith("--amount is no longer used: a seat carries no DEM")
    }

    const solanaRpc =
        flags["solana-rpc"] ||
        process.env.SOLANA_RPC?.split(",")[0]?.trim() ||
        (process.env.HELIUS_API_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
            : PUBLIC_SOLANA_RPC)

    globalThis.validatorCtx = {
        identity: flags.identity ?? DEFAULT_IDENTITY_FILE,
        rpc: flags.rpc ?? firstPeerlistRpc(),
        solanaRpc: solanaRpc || PUBLIC_SOLANA_RPC,
        flags,
    }

    switch (command) {
        case "nft-proof":
            return cmdNftProof()
        case "stake":
            return cmdStake()
        case "unstake":
            return cmdUnstake()
        case "exit":
            return cmdExit()
        case "challenge":
            return cmdChallenge()
        default:
            exitWith(`unknown command: ${command ?? "(none)"}\n${USAGE}`)
    }
}

main().catch(e => exitWith(e))
