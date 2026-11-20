/* eslint-disable no-console */
/**
 * Genesis seed seats: a fresh Demos identity per chosen node NFT, each
 * bound by a proof sent to Solana from the wallet in --key.
 *
 *   bun scripts/genesis-seeds.ts --key <solana key file> [--account <n>] > seeds.json
 *
 * Prompts on stderr for which of the wallet's allowlisted NFTs to use and for
 * the EXPOSED_URL of the node that will run each seat, then prints one JSON
 * document on stdout: the `validators` rows for
 * data/genesis.json and the `mnemonics` of their identity files, keyed by
 * address. stdout holds signing keys: redirect it to a file. If a proof
 * fails after others finished, the finished seats are still printed.
 */
import "dotenv/config"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"

import { Connection, PublicKey } from "@solana/web3.js"

import { NFT_ALLOWLIST_PATH, NFT_ALLOWLIST_SHA256, parseAllowlist } from "../src/features/staking/nftAllowlist"
import { TOKEN_PROGRAM_ID } from "../src/features/staking/proofBytes"
import { verifySeededNfts } from "../src/features/staking/seedNft"
import { newDemosIdentity } from "./demos-identity"
import { connectionUrlProblem } from "./genesis-hash"
import { PUBLIC_SOLANA_RPC, proveNft } from "./solana-proof"
import { ACCEPTED_SECRET_FORMATS, loadSolanaSigner } from "./solana-signer"

export interface SeedRow {
    address: string
    status: "2"
    connection_url: string
    staked_amount: "0"
    first_seen: 0
    valid_at: 0
    nft_mint: string
    nft_owner: string
    nft_proof_tx: string
}

export function seedRow(address: string, mint: string, owner: string, proofTx: string, url: string): SeedRow {
    return {
        address,
        status: "2",
        connection_url: url,
        staked_amount: "0",
        first_seen: 0,
        valid_at: 0,
        nft_mint: mint,
        nft_owner: owner,
        nft_proof_tx: proofTx,
    }
}

/** The chosen 1-based numbers out of `count`, in order, each at most once. */
export function parseSelection(input: string, count: number): number[] {
    const picks = input.trim().split(/[\s,]+/).filter(s => s !== "").map(Number)
    if (picks.length === 0) throw new Error("pick at least one mint")
    for (const n of picks) {
        if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`${n} is not a number between 1 and ${count}`)
    }
    if (new Set(picks).size !== picks.length) throw new Error("a mint backs one seat; pick each number once")
    return picks
}

/**
 * A seat's connection URL: the EXPOSED_URL its node runs with. Launch checks
 * (go/no-go, launch-height1-check) reach block 0's validators at this URL, so
 * a seat is not written without one.
 */
export function parseSeatUrl(input: string, taken: ReadonlySet<string>): string {
    const raw = input.trim()
    if (raw === "") throw new Error("a seat needs the EXPOSED_URL of the node that runs it")
    const problem = connectionUrlProblem(raw)
    if (problem) throw new Error(`${raw} ${problem}`)
    const parsed = new URL(raw)
    if (parsed.search !== "" || parsed.hash !== "") throw new Error(`${raw} carries a query or fragment`)
    // The canonical spelling (lower-case scheme and host, no default port, no
    // trailing slash) is what launch checks parse and what tells two seats apart.
    const url = parsed.origin + parsed.pathname.replace(/\/+$/, "")
    if (taken.has(url)) throw new Error(`${url} is already the URL of another seat`)
    return url
}

function flag(name: string): string | undefined {
    const at = process.argv.indexOf(`--${name}`)
    return at === -1 ? undefined : process.argv[at + 1]
}

/** An allowlisted node NFT the wallet holds, and the token account it sits in. */
interface HeldNft {
    mint: string
    tokenAccount: PublicKey
}

/**
 * The allowlisted node NFTs the wallet holds. The token account is kept
 * because an NFT need not sit in the wallet's associated account, and the
 * proof must move it out of the account that holds it.
 */
async function heldAllowlistedMints(connection: Connection, owner: PublicKey): Promise<HeldNft[]> {
    const allowed = parseAllowlist(readFileSync(NFT_ALLOWLIST_PATH, "utf8"), NFT_ALLOWLIST_SHA256)
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "finalized")
    const mints: HeldNft[] = []
    for (const { pubkey, account } of accounts.value) {
        const info = account.data.parsed?.info as
            | { mint?: string; tokenAmount?: { amount?: string; decimals?: number } }
            | undefined
        const mint = info?.mint
        if (mint && info.tokenAmount?.amount === "1" && info.tokenAmount.decimals === 0 && allowed.has(mint)) {
            mints.push({ mint, tokenAccount: pubkey })
        }
    }
    return mints
}

async function main(): Promise<void> {
    const keyFile = flag("key")
    if (!keyFile) throw new Error(`usage: genesis-seeds --key <key file> [--account <n>] (${ACCEPTED_SECRET_FORMATS})`)
    const account = flag("account")
    const { keypair } = loadSolanaSigner(keyFile, { account: account === undefined ? 0 : Number(account) })
    const owner = keypair.publicKey.toBase58()
    console.error(`Solana signer: ${owner}`)

    const rpc = process.env.SOLANA_RPC?.split(",")[0]?.trim() || PUBLIC_SOLANA_RPC
    const connection = new Connection(rpc, { commitment: "finalized" })
    const mints = await heldAllowlistedMints(connection, keypair.publicKey)
    if (mints.length === 0) throw new Error(`${owner} holds no allowlisted node NFT`)
    mints.forEach(({ mint }, i) => console.error(`  ${i + 1}. ${mint}`))

    const rl = createInterface({ input: process.stdin, output: process.stderr })
    const answer = await rl.question("Mints to bind, one seat each (numbers, e.g. 1 3 4): ")
    const chosen = parseSelection(answer, mints.length).map(n => mints[n - 1])
    // Asked before any proof is sent, so a typo costs no Solana transaction.
    const urls: string[] = []
    for (const { mint } of chosen) {
        urls.push(parseSeatUrl(await rl.question(`EXPOSED_URL of the node for ${mint}: `), new Set(urls)))
    }
    rl.close()

    const validators: SeedRow[] = []
    const mnemonics: Record<string, string> = {}
    try {
        for (const [i, { mint, tokenAccount }] of chosen.entries()) {
            const { mnemonic, address } = await newDemosIdentity()
            const proofTx = await proveNft(
                connection,
                keypair,
                new PublicKey(mint),
                address,
                line => console.error(line),
                tokenAccount,
            )
            validators.push(seedRow(address, mint, owner, proofTx, urls[i]))
            mnemonics[address] = mnemonic
        }
    } catch (e) {
        if (validators.length > 0) {
            console.error(`stopped after ${validators.length} of ${chosen.length} seats; the finished ones follow on stdout`)
            console.log(JSON.stringify({ validators, mnemonics }, null, 2))
        }
        throw e
    }
    // The check go/no-go repeats before the genesis is sealed; nodes building
    // block 0 never read Solana, so a bad proof must be caught here or there.
    const refused = await verifySeededNfts(validators, "seeds")
    console.error("stdout holds the seed nodes' signing mnemonics")
    console.log(JSON.stringify({ validators, mnemonics }, null, 2))
    if (refused.length > 0) {
        throw new Error(`the seats above do not verify on Solana: ${refused.join("; ")}`)
    }
}

if (import.meta.main) {
    main().catch((e: unknown) => {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
    })
}
