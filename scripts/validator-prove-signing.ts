/**
 * Signing-path proof for a launch validator.
 *
 * Sign mode, on the validator host, with the production identity file:
 *
 *   bun scripts/validator-prove-signing.ts --genesis-hash HASH [--date YYYY-MM-DD]
 *       [--identity-file PATH] [--out FILE]
 *
 * loads the identity the way the node does (Identity.loadIdentity) and signs
 * `demos-launch-proof:<genesisHash>:<date>` through the node's signing pool
 * (TxValidatorPool.sign, the call createBlock uses for block signatures). It
 * prints { identity, algorithm, challenge, signature } and nothing secret.
 * It only reads the identity file: it never creates one, never writes the
 * block signing record, and refuses to run when the signing stop marker
 * exists. The challenge has a fixed prefix, so the signature can never be
 * reused as a block signature (those sign a bare block hash).
 *
 * Verify mode, anywhere:
 *
 *   bun scripts/validator-prove-signing.ts --verify proofs.json --genesis genesis.json
 *       --snapshot DIR [--genesis-hash HASH] [--date YYYY-MM-DD] [--require-all]
 *
 * proofs.json is an array of sign-mode outputs. Every proof must come from a
 * launch validator (staked at block 0: from the snapshot's validators.jsonl
 * when it has one, else from the genesis), name the block 0 hash the genesis
 * file builds (as must --genesis-hash when given), carry the expected date
 * and verify; with --require-all every launch validator must have one.
 * Exit codes: 0 ok, 1 a proof failed or one is missing, 2 bad input or refused.
 */

import * as fs from "fs"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"

export const CHALLENGE_PREFIX = "demos-launch-proof"
const HASH_RE = /^(0x)?[0-9a-f]{64}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Hashes and identities compare without case or a 0x prefix: tools and operators write both. */
const normHex = (hex: string) => hex.trim().toLowerCase().replace(/^0x/, "")

export interface SigningProof {
    identity: string
    algorithm?: string
    challenge: string
    signature: string
}

export function buildChallenge(genesisHash: string, date: string): string {
    if (!HASH_RE.test(genesisHash)) {
        throw new Error(`genesis hash must be 64 hex characters, got ${JSON.stringify(genesisHash)}`)
    }
    if (!DATE_RE.test(date)) {
        throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
    }
    return `${CHALLENGE_PREFIX}:${normHex(genesisHash)}:${date}`
}

export function parseChallenge(challenge: string): { genesisHash: string; date: string } | null {
    const parts = challenge.split(":")
    if (parts.length !== 3 || parts[0] !== CHALLENGE_PREFIX) return null
    const [, genesisHash, date] = parts
    if (!HASH_RE.test(genesisHash) || !DATE_RE.test(date)) return null
    return { genesisHash: normHex(genesisHash), date }
}

export type SignatureCheck = (message: Uint8Array, signatureHex: string, publicKeyHex: string) => Promise<boolean>

/** ed25519 verification through the SDK's unified crypto, as the node's validator workers do. */
export const verifyEd25519: SignatureCheck = async (message, signatureHex, publicKeyHex) => {
    try {
        return await ucrypto.verify({
            algorithm: "ed25519",
            message,
            signature: hexToUint8Array(signatureHex),
            publicKey: hexToUint8Array(publicKeyHex),
        })
    } catch {
        return false
    }
}

export interface ProofReport {
    identity: string
    ok: boolean
    reason: string | null
}

export interface VerifyResult {
    ok: boolean
    genesisHash: string | null
    reports: ProofReport[]
    missing: string[]
}

/**
 * Checks proofs against the launch validator list. Without an expected
 * genesis hash, every proof must name the same one.
 */
export async function verifyProofs(
    proofs: SigningProof[],
    validators: string[],
    opts: { genesisHash?: string | null; date?: string | null; requireAll?: boolean } = {},
    check: SignatureCheck = verifyEd25519,
): Promise<VerifyResult> {
    const listed = new Map(validators.map(v => [normHex(v), v.toLowerCase()]))
    let genesisHash = opts.genesisHash ? normHex(opts.genesisHash) : null
    const reports: ProofReport[] = []
    const proven = new Set<string>()

    for (const proof of proofs) {
        const identity = typeof proof?.identity === "string" ? proof.identity.toLowerCase() : ""
        const fail = (reason: string) => reports.push({ identity: identity || "(none)", ok: false, reason })
        if (!identity || typeof proof.challenge !== "string" || typeof proof.signature !== "string") {
            fail("malformed proof: identity, challenge and signature are required")
            continue
        }
        if (proof.algorithm !== undefined && proof.algorithm !== "ed25519") {
            fail(`algorithm ${proof.algorithm}; block signatures are ed25519`)
            continue
        }
        const key = normHex(identity)
        if (!listed.has(key)) {
            fail("not a launch validator")
            continue
        }
        const parsed = parseChallenge(proof.challenge)
        if (!parsed) {
            fail(`challenge is not ${CHALLENGE_PREFIX}:<genesisHash>:<YYYY-MM-DD>`)
            continue
        }
        if (genesisHash === null) genesisHash = parsed.genesisHash
        if (parsed.genesisHash !== genesisHash) {
            fail(`challenge names genesis ${parsed.genesisHash}, expected ${genesisHash}`)
            continue
        }
        if (opts.date && parsed.date !== opts.date) {
            fail(`challenge is dated ${parsed.date}, expected ${opts.date}`)
            continue
        }
        if (proven.has(key)) {
            fail("duplicate proof for this identity")
            continue
        }
        // The signature covers the challenge exactly as it was signed
        if (!(await check(new TextEncoder().encode(proof.challenge), proof.signature, `0x${key}`))) {
            fail("signature does not verify for this identity")
            continue
        }
        proven.add(key)
        reports.push({ identity, ok: true, reason: null })
    }

    const missing = [...listed].filter(([key]) => !proven.has(key)).map(([, v]) => v)
    const ok = reports.every(r => r.ok) && (!opts.requireAll || missing.length === 0) && proven.size > 0
    return { ok, genesisHash, reports, missing }
}

/** Block 0 of the --genesis file, as scripts/genesis-hash.ts computes it. */
export interface GenesisBlock {
    /** null when block 0 cannot be known before launch. */
    blockHash: string | null
    dataHash: string
    problems: string[]
}

/**
 * verifyProofs against the launch genesis file: every proof must name the
 * block 0 that file builds, and so must --genesis-hash when given. Proofs
 * that agree only with each other prove nothing about the chain the file
 * starts.
 */
export async function verifyLaunchProofs(
    proofs: SigningProof[],
    validators: string[],
    genesis: GenesisBlock,
    opts: { genesisHash?: string | null; date?: string | null; requireAll?: boolean } = {},
    check: SignatureCheck = verifyEd25519,
): Promise<VerifyResult & { problems: string[] }> {
    const problems: string[] = []
    const blockHash = genesis.blockHash === null ? null : normHex(genesis.blockHash)
    const dataHash = normHex(genesis.dataHash)
    const flag = opts.genesisHash ? normHex(opts.genesisHash) : null
    const dataHashNote = "that is the genesis data hash; proofs sign the genesis block hash scripts/genesis-hash.ts prints"
    if (blockHash === null) {
        problems.push(
            `block 0 of the genesis file cannot be known before launch: ${genesis.problems.join("; ") || "unknown reason"}`,
        )
    }
    if (flag !== null && blockHash !== null && flag !== blockHash) {
        problems.push(
            `--genesis-hash ${flag} is not block 0 of the genesis file, which builds ${blockHash}` +
                (flag === dataHash ? `: ${dataHashNote}` : ""),
        )
    }
    // Each proof is held to the file's block 0, so one naming anything else fails by name
    const result = await verifyProofs(proofs, validators, { ...opts, genesisHash: blockHash ?? flag }, check)
    const named = new Set(
        proofs.map(p => (typeof p?.challenge === "string" ? parseChallenge(p.challenge)?.genesisHash : null)),
    )
    if (named.has(dataHash)) problems.push(`some proofs name genesis ${dataHash}: ${dataHashNote}`)
    return { ...result, ok: result.ok && problems.length === 0, problems }
}

// ── sign mode ────────────────────────────────────────────────────────────

async function signChallenge(identityFile: string, challenge: string): Promise<SigningProof> {
    if (!fs.existsSync(identityFile)) {
        // loadIdentity would generate a fresh key here
        throw new Error(`identity file ${identityFile} does not exist; refusing to sign`)
    }
    const { signingHaltMarkerPath } = await import("src/libs/identity/signingRecord")
    const marker = signingHaltMarkerPath(identityFile)
    if (fs.existsSync(marker)) {
        throw new Error(
            `signing is stopped by ${marker}; a second copy of this key may be running. Resolve that first`,
        )
    }
    const { getSharedState } = await import("src/utilities/sharedState")
    const validatorPool = (await import("src/libs/blockchain/validation/txValidatorPool")).default
    const { uint8ArrayToHex } = await import("@kynesyslabs/demosdk/encryption")

    getSharedState.identityFile = identityFile
    const keypair = await getSharedState.identity.loadIdentity()
    const identity = uint8ArrayToHex(keypair.publicKey as Uint8Array)
    const algorithm = getSharedState.signingAlgorithm

    const pool = validatorPool.getInstance()
    await pool.start(1)
    try {
        const signed = await pool.sign(algorithm, new TextEncoder().encode(challenge))
        const signer = uint8ArrayToHex(signed.publicKey as Uint8Array)
        if (signer !== identity) {
            throw new Error(`the signing pool signed as ${signer}, not as the identity file's ${identity}`)
        }
        const signature = uint8ArrayToHex(signed.signature as Uint8Array)
        if (!(await verifyEd25519(new TextEncoder().encode(challenge), signature, identity))) {
            throw new Error("the signature does not verify; refusing to hand it out")
        }
        return { identity, algorithm, challenge, signature }
    } finally {
        await pool.stop()
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function usage(): string {
    return [
        "sign:   bun scripts/validator-prove-signing.ts --genesis-hash HASH [--date YYYY-MM-DD]",
        "            [--identity-file PATH] [--out FILE]",
        "verify: bun scripts/validator-prove-signing.ts --verify proofs.json --genesis genesis.json",
        "            --snapshot DIR [--genesis-hash HASH] [--date YYYY-MM-DD] [--require-all]",
    ].join("\n")
}

async function main(argv: string[]): Promise<number> {
    const opts: Record<string, string | boolean> = {}
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]
        if (flag === "--require-all") opts.requireAll = true
        else if (flag === "-h" || flag === "--help") {
            console.log(usage())
            return 0
        } else if (
            ["--genesis-hash", "--date", "--identity-file", "--out", "--verify", "--genesis", "--snapshot"].includes(flag)
        ) {
            const v = argv[++i]
            if (v === undefined) {
                console.error(`${flag} needs a value\n${usage()}`)
                return 2
            }
            opts[flag.slice(2)] = v
        } else {
            console.error(`unknown argument ${flag}\n${usage()}`)
            return 2
        }
    }

    if (typeof opts.verify === "string") {
        if (typeof opts.genesis !== "string") {
            console.error(`--verify needs --genesis\n${usage()}`)
            return 2
        }
        if (typeof opts.snapshot !== "string") {
            const { NO_SNAPSHOT_REASON } = await import("./launch-validator-set")
            console.error(`--verify needs --snapshot: ${NO_SNAPSHOT_REASON}\n${usage()}`)
            return 2
        }
        const { readGenesisFile, genesisValues } = await import("./genesis-hash")
        const genesis = readGenesisFile(opts.genesis)
        const values = genesisValues(genesis)
        const { readBlockZeroValidators, launchIdentities } = await import("./launch-validator-set")
        let blockZero: Awaited<ReturnType<typeof readBlockZeroValidators>>
        try {
            blockZero = await readBlockZeroValidators(genesis, opts.snapshot)
        } catch (e) {
            console.error(`snapshot: ${(e as Error).message}`)
            return 2
        }
        for (const w of blockZero.warnings) console.log(`warning: ${w}`)
        for (const r of blockZero.reasons) console.log(`FAIL ${r}`)
        const validators = launchIdentities(blockZero.rows)
        const raw = JSON.parse(fs.readFileSync(opts.verify, "utf8"))
        const proofs: SigningProof[] = Array.isArray(raw) ? raw : [raw]
        const result = await verifyLaunchProofs(
            proofs,
            validators,
            { blockHash: values.genesisBlockHash, dataHash: values.genesisDataHash, problems: values.problems },
            {
                genesisHash: (opts["genesis-hash"] as string) ?? null,
                date: (opts.date as string) ?? null,
                requireAll: opts.requireAll === true,
            },
        )
        for (const p of result.problems) console.log(`FAIL ${p}`)
        for (const r of result.reports) {
            console.log(`${r.ok ? "ok  " : "FAIL"} ${r.identity}${r.reason ? `: ${r.reason}` : ""}`)
        }
        for (const m of result.missing) console.log(`${opts.requireAll ? "MISSING" : "no proof"} ${m}`)
        console.log(
            `${result.reports.filter(r => r.ok).length} of ${validators.length} launch validators proven` +
                ` on genesis ${result.genesisHash ?? "-"}: ${result.ok && blockZero.reasons.length === 0 ? "OK" : "NOT OK"}`,
        )
        return result.ok && blockZero.reasons.length === 0 ? 0 : 1
    }

    if (typeof opts["genesis-hash"] !== "string") {
        console.error(`--genesis-hash is required to sign\n${usage()}`)
        return 2
    }
    const date = (opts.date as string) ?? new Date().toISOString().slice(0, 10)
    let challenge: string
    try {
        challenge = buildChallenge(opts["genesis-hash"], date)
    } catch (e) {
        console.error((e as Error).message)
        return 2
    }
    const identityFile =
        (opts["identity-file"] as string) ?? process.env.IDENTITY_FILE ?? ".demos_identity"
    let proof: SigningProof
    try {
        proof = await signChallenge(identityFile, challenge)
    } catch (e) {
        console.error(`refused: ${(e as Error).message}`)
        return 2
    }
    const out = JSON.stringify(proof, null, 2)
    if (typeof opts.out === "string") fs.writeFileSync(opts.out, out + "\n")
    // Last on stdout, after any node log lines, so `tail` or --out gets it clean
    console.log(out)
    return 0
}

if (import.meta.main) {
    main(process.argv.slice(2)).then(
        code => process.exit(code),
        e => {
            console.error(e)
            process.exit(2)
        },
    )
}
