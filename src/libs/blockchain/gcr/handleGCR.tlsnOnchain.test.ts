/**
 * The TLSNotary token and proof on chain under `tlsnVerified`: a
 * `tlsn_request` writes its token row at apply, a `tlsn_store` whose
 * presentation verifies fills in the proof of the sender's own pending,
 * unexpired request, once per request and once per attestation id. The rows
 * come from node-derived edits, so two validators with different clocks hold
 * the same table and the same table hash, and a reverted block undoes them.
 *
 * Transactions are built and signed by the SDK builders the TLSNotary service
 * uses. The presentation gate's verifier is replaced by a stand-in whose
 * "presentation" is a JSON description of the facts it should report; the
 * real verifier and its vectors are covered in src/libs/tlsnotary.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => tip,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
const quiet = Object.fromEntries(
    ["debug", "info", "warning", "error", "only", "custom"].map(level => [
        level,
        () => {},
    ]),
)
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: quiet,
}))

const FAKE_WASM_SHA256 = "cd".repeat(32)
let verifierCalls = 0

interface FakeFacts {
    id: string
    server?: string | null
    time: number
    bind?: string
    key?: number
    revealAuthorization?: boolean
    revealCookie?: boolean
    invalid?: boolean
}

const RESPONSE = "HTTP/1.1 200 OK\r\nset-cookie: s=1\r\ncontent-length: 2\r\n\r\n{}"

function fakeVerify(bytes: Uint8Array) {
    verifierCalls++
    let facts: FakeFacts
    try {
        facts = JSON.parse(Buffer.from(bytes).toString("utf8"))
    } catch {
        return { ok: false as const }
    }
    if (facts.invalid) return { ok: false as const }
    const head =
        "GET /resource HTTP/1.1\r\n" +
        `Host: ${facts.server === undefined ? "api.github.com" : (facts.server ?? "x")}\r\n` +
        (facts.bind ? `X-Demos-Bind: ${facts.bind}\r\n` : "") +
        "Authorization: Bearer secret-token\r\n" +
        "\r\n"
    const sent = Buffer.from(head, "latin1")
    const authStart = head.indexOf("Authorization:")
    const valueStart = authStart + "Authorization: ".length
    const valueEnd = head.indexOf("\r\n", authStart)
    // Everything but the credential, unless the test reveals it.
    const sentAuthed: [number, number][] = facts.revealAuthorization
        ? [[0, sent.length]]
        : [
              [0, valueStart],
              [valueEnd, sent.length],
          ]
    const shown = Buffer.from(sent)
    if (!facts.revealAuthorization) shown.fill(0, valueStart, valueEnd)
    const recv = Buffer.from(RESPONSE, "latin1")
    const cookie = RESPONSE.indexOf("s=1")
    const recvAuthed: [number, number][] = facts.revealCookie
        ? [[0, recv.length]]
        : [
              [0, cookie],
              [cookie + 3, recv.length],
          ]
    if (!facts.revealCookie) recv.fill(0, cookie, cookie + 3)
    return {
        ok: true as const,
        raw: "",
        out: {
            ok: true as const,
            attestationId: facts.id,
            attestationVersionIsCurrent: true,
            signatureAlg: "secp256k1",
            verifyingKey: { alg: "k256", hex: notaryKeyHex(facts.key ?? 0x11) },
            serverName:
                facts.server === undefined ? "api.github.com" : facts.server,
            time: facts.time,
            tlsVersion: "1.2",
            transcriptLength: { sent: sent.length, received: recv.length },
            sent: shown.toString("hex"),
            sentAuthed,
            recv: recv.toString("hex"),
            recvAuthed,
            extensions: 0,
        },
    }
}


import { Demos } from "@kynesyslabs/demosdk/websdk"
import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary/service"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import type { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import {
    tlsnRequestOf,
    TLSN_REQUEST_TTL_BLOCKS,
} from "@/libs/tlsnotary/onchainRequests"
import {
    notaryKeyHex,
    tlsnVerifiedPayload,
} from "@/libs/blockchain/testSupport/tlsnVerifiedFixtures"
import {
    OS,
    SENDER,
    chainIs,
    demos,
    onTheWire,
} from "@/libs/blockchain/validation/editBinding.fixtures"
import type { GCREntityCaches } from "./handleGCR"
import { tlsnTableDigest } from "./gcr_routines/hashGCR"
import { tlsnAdmissionCopy } from "./tlsnTransitions"
import { setPresentationVerifierForTests } from "@/libs/tlsnotary/presentationGate"
import { TlsnVerifierUnavailableAtApplyError } from "@/libs/tlsnotary/verifiedIdentity"
import { StateReadError } from "./stateReadError"

const { default: HandleGCR } = await import("./handleGCR")

const other: any = new Demos()
await other.connectWalletFromPrivateKey("0x" + "22".repeat(32), {
    algorithm: "ed25519",
})
other.getAddressNonce = async () => 7
other._isPostForkCached = async () => true
other._assertAmountAcceptableOnTargetNode = async () => {}
other._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 0 })
other._chainIdCached = async () => "devnet"
other._isSignatureDomainActiveCached = async () => false
const OTHER: string = other.getAddress()

// Admission judges freshness against the wall clock, a block against its own time.
const BLOCK_TIME = Math.floor(Date.now() / 1000)
const URL_ = "https://api.github.com/user"

async function request(
    wallet: any = demos,
    nonce = 8,
    url = URL_,
): Promise<Transaction> {
    wallet.connected = true
    const service = new TLSNotaryService(wallet) as any
    return onTheWire(await service.createTlsnRequestTransaction(url, nonce))
}

async function store(
    tokenId: string,
    facts: FakeFacts | string,
    opts: { wallet?: any; nonce?: number; storage?: string } = {},
): Promise<Transaction> {
    const wallet = opts.wallet ?? demos
    wallet.connected = true
    const proof =
        typeof facts === "string"
            ? facts
            : JSON.stringify({
                  version: "0.1.0-alpha.12",
                  data: Buffer.from(JSON.stringify(facts)).toString("hex"),
                  meta: { notaryUrl: "unsigned" },
              })
    const service = new TLSNotaryService(wallet) as any
    return onTheWire(
        await service.createTlsnStoreTransaction(
            tokenId,
            proof,
            opts.storage ?? "onchain",
            2n * OS,
            opts.nonce ?? 9,
        ),
    )
}

/** The bind value the SDK writes: the sender with 0x, the request hash without. */
const bind = (requestHash: string, sender = SENDER, context = "store") =>
    `demos-tlsn:v1:${context}:${sender}:${requestHash}`

const facts = (
    requestHash: string,
    extra: Partial<FakeFacts> = {},
): FakeFacts => ({
    // Hex, as the verifier reports attestation ids.
    id: "a7" + requestHash.slice(0, 14),
    time: BLOCK_TIME - 30,
    bind: bind(requestHash),
    ...extra,
})

/** One validator's state: its caches stand in for its database. */
class Validator {
    caches: GCREntityCaches
    constructor(readonly clockMs: number) {
        this.caches = {
            accounts: new Map([
                [
                    SENDER,
                    { pubkey: SENDER, balance: 100n * OS, nonce: 7 } as any,
                ],
                [OTHER, { pubkey: OTHER, balance: 100n * OS, nonce: 7 } as any],
            ]),
            storagePrograms: new Map(),
            tlsNotaries: new Map(),
            atomicWorks: new Map(),
            resourceSlots: new Map(),
        }
    }

    /** Applies a block at `height` (the tip is the block before it), as forging or syncing does. */
    async apply(height: number, txs: Transaction[], rollback = false) {
        current = this
        getSharedState.lastBlockNumber = height - 1
        tip = height - 1
        const out = await HandleGCR.applyTransactions(
            txs,
            rollback,
            rollback ? undefined : { height, timestampSec: BLOCK_TIME },
        )
        // What each node's database stamps on a new row: its own clock.
        for (const row of this.caches.tlsNotaries.values()) {
            if (row && !row.createdAt) row.createdAt = new Date(this.clockMs)
        }
        return out
    }

    rows(): GCRTLSNotary[] {
        return [...this.caches.tlsNotaries.values()].filter(
            (r): r is GCRTLSNotary => r !== null,
        )
    }

    row(tokenId: string): GCRTLSNotary | null {
        return this.caches.tlsNotaries.get(tokenId) ?? null
    }

    digest(): string {
        return tlsnTableDigest(this.rows(), true)
    }
}

let current: Validator
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
const savedForks = getSharedState.forkConfig

/** The forks of the edit-binding fixtures, without fee distribution, whose runtime view these tests do not prime. */
function baseForks(): void {
    chainIs(true, 0)
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
    getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
}

function forksWithTlsn(): void {
    baseForks()
    const forks = getSharedState.forkConfig as any
    forks.tlsnVerified = {
        ...forks.tlsnVerified,
        activationHeight: 0,
        ...tlsnVerifiedPayload({
            verifierWasmSha256: FAKE_WASM_SHA256,
            maxPresentationBytes: 4096,
        }),
    }
}

beforeEach(() => {
    ;(HandleGCR as any).prepareEntities = async () => current.caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
    forksWithTlsn()
    verifierCalls = 0
    getSharedState.tlsnTokenStore = null
    setPresentationVerifierForTests({
        wasmSha256: FAKE_WASM_SHA256,
        verify: bytes => fakeVerify(bytes) as never,
    })
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    Object.assign(HandleGCR, original)
    setPresentationVerifierForTests(null)
    const timer = getSharedState.tlsnTokenStore?.cleanupTimer
    if (timer) clearInterval(timer)
})

/**
 * Why admission on `v` refuses `tx` for a block at `height`: the stateless
 * refusal, or the message of the simulation on a copy of its rows.
 */
async function admissionRefusal(
    v: Validator,
    height: number,
    tx: Transaction,
): Promise<string> {
    current = v
    getSharedState.lastBlockNumber = height - 1
    const admitted = tlsnAdmissionCopy(tx)
    if (admitted.ok === false) return admitted.reason
    const sim = await HandleGCR.applyTransaction(
        structuredClone(v.caches),
        admitted.tx,
        false,
        true,
    )
    return sim.success ? "" : sim.message
}

/** Two validators, request in block 101, then whatever block 102 holds. */
async function twoValidators() {
    const a = new Validator(Date.UTC(2026, 10, 17, 1))
    const b = new Validator(Date.UTC(2026, 10, 17, 9))
    const req = await request()
    for (const v of [a, b]) {
        const out = await v.apply(101, [req])
        expect(out.successfulTxs).toEqual([req.hash])
    }
    return { a, b, req }
}

describe("tlsn_request under tlsnVerified", () => {
    it("writes a pending token keyed by the request hash, owned by the sender, expiring by height", async () => {
        const { a, b, req } = await twoValidators()

        expect(tlsnRequestOf(a.row(req.hash))).toEqual({
            tokenId: req.hash,
            owner: SENDER,
            domain: "api.github.com",
            status: "pending",
            requestHeight: 101,
            expiresAtHeight: 101 + TLSN_REQUEST_TTL_BLOCKS,
        })
        expect(a.digest()).toBe(b.digest())
        // The pre-fork hash covers each node's clock and would split.
        expect(tlsnTableDigest(a.rows(), false)).not.toBe(
            tlsnTableDigest(b.rows(), false),
        )
    })

    it("creates no off-chain token at admission: state changes only at apply", async () => {
        const v = new Validator(0)
        current = v
        getSharedState.lastBlockNumber = 100
        const req = await request()

        const admitted = tlsnAdmissionCopy(req)
        expect(admitted.ok).toBe(true)
        if (!admitted.ok) return
        const sim = await HandleGCR.applyTransaction(
            structuredClone(v.caches),
            admitted.tx,
            false,
            true,
        )

        expect(sim.success).toBe(true)
        expect(getSharedState.tlsnTokenStore?.tokens.size ?? 0).toBe(0)
        expect(v.rows()).toHaveLength(0)
    })

    it("is refused, with no fee, when the URL names no https host", async () => {
        const v = new Validator(0)
        const req = await request(demos, 8, "http://api.github.com/user")

        const out = await v.apply(101, [req])

        expect(out.failedTxs).toEqual([req.hash])
        expect(v.rows()).toHaveLength(0)
        expect(v.caches.accounts.get(SENDER)!.balance).toBe(100n * OS)
    })

    it("leaves the signed transaction as it was: the derived edit lives only in the applied copy", async () => {
        const v = new Validator(0)
        const req = await request()
        const signed = JSON.stringify(req.content.gcr_edits)

        await v.apply(101, [req])

        expect(JSON.stringify(req.content.gcr_edits)).toBe(signed)
        expect(signed).not.toContain("tlsnotary")
    })
})

describe("tlsn_store under tlsnVerified", () => {
    it("round trip: admitted, applied on two validators to the same row and table hash, then read back", async () => {
        const { a, b, req } = await twoValidators()
        const st = await store(req.hash, facts(req.hash))

        current = a
        getSharedState.lastBlockNumber = 101
        const admitted = tlsnAdmissionCopy(st)
        expect(admitted.ok).toBe(true)
        if (!admitted.ok) return
        // Admission simulates on rows freshly loaded for it, never on the block's caches.
        const sim = await HandleGCR.applyTransaction(
            structuredClone(a.caches),
            admitted.tx,
            false,
            true,
        )
        expect(sim.success).toBe(true)
        expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")

        for (const v of [a, b]) {
            const out = await v.apply(102, [st])
            expect(out.successfulTxs).toEqual([st.hash])
        }

        const row = a.row(req.hash)!
        expect(row.status).toBe("stored")
        expect(row.attestationId).toBe(facts(req.hash).id)
        expect(row.storedAtHeight).toBe(102)
        expect(row.txhash).toBe(st.hash)
        expect(row.storageType).toBe("onchain")
        expect(row.proofTimestamp).toBe(String((BLOCK_TIME - 30) * 1000))
        // Stored without the unsigned meta, data as lowercase hex.
        expect(JSON.parse(row.proof!)).toEqual({
            version: "0.1.0-alpha.12",
            data: Buffer.from(JSON.stringify(facts(req.hash))).toString("hex"),
        })
        expect(a.digest()).toBe(b.digest())
        expect(a.row(req.hash)!.createdAt).not.toEqual(
            b.row(req.hash)!.createdAt,
        )
    })

    it("applies a request and its store in one block, in block order", async () => {
        const v = new Validator(0)
        const req = await request()
        const st = await store(req.hash, facts(req.hash))

        const out = await v.apply(101, [req, st])

        expect(out.successfulTxs.sort()).toEqual([req.hash, st.hash].sort())
        expect(v.row(req.hash)!.status).toBe("stored")
        expect(v.row(req.hash)!.storedAtHeight).toBe(101)
    })

    it("rolls back on block revert: store first, then the request, back to the table before each", async () => {
        const { a, req } = await twoValidators()
        const afterRequest = a.digest()
        const st = await store(req.hash, facts(req.hash))
        await a.apply(102, [st])
        expect(a.digest()).not.toBe(afterRequest)

        const undoStore = await a.apply(103, [st], true)
        expect(undoStore.failedTxs).toEqual([])
        expect(a.digest()).toBe(afterRequest)
        expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")

        const undoRequest = await a.apply(103, [req], true)
        expect(undoRequest.failedTxs).toEqual([])
        expect(a.rows()).toHaveLength(0)
        expect(a.digest()).toBe(tlsnTableDigest([], true))
    })

    it("refuses a rollback of a request whose proof is still stored", async () => {
        const { a, req } = await twoValidators()
        await a.apply(102, [await store(req.hash, facts(req.hash))])

        const out = await a.apply(103, [req], true)

        expect(out.failedTxs).toEqual([req.hash])
        expect(a.row(req.hash)!.status).toBe("stored")
    })

    it("stores once per request: a second store on the same request fails", async () => {
        const { a, req } = await twoValidators()
        await a.apply(102, [await store(req.hash, facts(req.hash))])
        const before = a.digest()

        const replay = await store(
            req.hash,
            facts(req.hash, { id: "a8" + "00".repeat(7) }),
            { nonce: 10 },
        )
        expect(await admissionRefusal(a, 103, replay)).toContain(
            "ALREADY_USED",
        )
        const out = await a.apply(103, [replay])

        expect(out.failedTxs).toEqual([replay.hash])
        expect(a.digest()).toBe(before)
    })

    it("stores once per attestation id, even on another request of the same sender", async () => {
        const { a, req } = await twoValidators()
        const first = await store(req.hash, facts(req.hash))
        await a.apply(102, [first])
        const second = await request(demos, 10, "https://api.github.com/repos")
        await a.apply(103, [second])
        const before = a.digest()

        const replay = await store(
            second.hash,
            facts(second.hash, { id: facts(req.hash).id }),
            { nonce: 11 },
        )
        expect(await admissionRefusal(a, 104, replay)).toContain(
            "is already stored on token",
        )
        const out = await a.apply(104, [replay])

        expect(out.failedTxs).toEqual([replay.hash])
        expect(a.digest()).toBe(before)
    })

    it("refuses a store after the request expired", async () => {
        const { a, req } = await twoValidators()
        const st = await store(req.hash, facts(req.hash))

        expect(
            await admissionRefusal(a, 101 + TLSN_REQUEST_TTL_BLOCKS + 1, st),
        ).toContain("EXPIRED")
        const late = await a.apply(101 + TLSN_REQUEST_TTL_BLOCKS + 1, [st])
        expect(late.failedTxs).toEqual([st.hash])
        expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")

        const last = await a.apply(101 + TLSN_REQUEST_TTL_BLOCKS, [st])
        expect(last.successfulTxs).toEqual([st.hash])
    })

    it("refuses ipfs storage before apply, so it pays nothing", async () => {
        const { a, req } = await twoValidators()
        const balance = a.caches.accounts.get(SENDER)!.balance
        const st = await store(req.hash, facts(req.hash), { storage: "ipfs" })

        const out = await a.apply(102, [st])

        expect(out.failedTxs).toEqual([st.hash])
        expect(a.caches.accounts.get(SENDER)!.balance).toBe(balance)
        expect(verifierCalls).toBe(0)
        expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")
    })

    it("refuses a presentation over the fork's maxPresentationBytes, before the verifier runs", async () => {
        const { a, req } = await twoValidators()
        const big = facts(req.hash, { bind: bind(req.hash) + " ".repeat(5000) })
        const st = await store(req.hash, big)

        const out = await a.apply(102, [st])

        expect(out.failedTxs).toEqual([st.hash])
        expect(verifierCalls).toBe(0)
        const admitted = tlsnAdmissionCopy(st)
        expect(admitted.ok).toBe(false)
        if (admitted.ok === false) expect(admitted.reason).toContain("larger than the 4096 bytes")
    })

    it("refuses a store on another sender's request", async () => {
        const { a, req } = await twoValidators()
        const st = await store(
            req.hash,
            facts(req.hash, { bind: bind(req.hash, OTHER) }),
            { wallet: other, nonce: 8 },
        )

        expect(await admissionRefusal(a, 102, st)).toContain("OWNER_MISMATCH")
        const out = await a.apply(102, [st])

        expect(out.failedTxs).toEqual([st.hash])
        expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")
    })

    it("refuses a store that names no request on chain", async () => {
        const a = new Validator(0)
        const missing = "ab".repeat(32)
        const st = await store(missing, facts(missing))

        expect(await admissionRefusal(a, 102, st)).toContain("NOT_FOUND")
        const out = await a.apply(102, [st])

        expect(out.failedTxs).toEqual([st.hash])
        expect(a.rows()).toHaveLength(0)
    })

    it("refuses a store whose server is not the request's domain", async () => {
        const { a, req } = await twoValidators()
        const st = await store(
            req.hash,
            facts(req.hash, { server: "discord.com" }),
        )

        expect(await admissionRefusal(a, 102, st)).toContain("DOMAIN_MISMATCH")
        const out = await a.apply(102, [st])

        expect(out.failedTxs).toEqual([st.hash])
    })

    describe("presentation checks", () => {
        const cases: [string, (hash: string) => Partial<FakeFacts>][] = [
            ["it does not verify", () => ({ invalid: true })],
            ["the notary key is not listed", () => ({ key: 0x33 })],
            ["it names no server", () => ({ server: null })],
            [
                "it is older than the freshness window",
                () => ({ time: BLOCK_TIME - 3601 }),
            ],
            [
                "it is later than the block time plus skew",
                () => ({ time: BLOCK_TIME + 600 }),
            ],
            [
                "it reveals the Authorization header",
                () => ({ revealAuthorization: true }),
            ],
            [
                "it reveals a Set-Cookie value",
                () => ({ revealCookie: true }),
            ],
            [
                "its attestation id is not hex",
                () => ({ id: "att-1" }),
            ],
            ["it has no bind header", () => ({ bind: undefined })],
            [
                "it is bound to an identity context",
                hash => ({ bind: bind(hash, SENDER, "github") }),
            ],
            [
                "it is bound to another sender",
                hash => ({ bind: bind(hash, OTHER) }),
            ],
            [
                "it is bound to another request",
                () => ({ bind: bind("ef".repeat(32)) }),
            ],
        ]
        for (const [name, change] of cases) {
            it(`refuses a store when ${name}`, async () => {
                const { a, req } = await twoValidators()
                const st = await store(
                    req.hash,
                    facts(req.hash, change(req.hash)),
                )

                const out = await a.apply(102, [st])

                expect(out.failedTxs).toEqual([st.hash])
                expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")
                expect(tlsnAdmissionCopy(st).ok).toBe(false)
            })
        }

        it("refuses a proof that is not a presentation", async () => {
            const { a, req } = await twoValidators()
            const st = await store(req.hash, "not json")

            const out = await a.apply(102, [st])

            expect(out.failedTxs).toEqual([st.hash])
        })
    })

    for (const editBinding of [0, null]) {
        it(`refuses a store that ships its own proof row (editBinding ${editBinding === null ? "dormant" : "active"})`, async () => {
            getSharedState.forkConfig.editBinding.activationHeight = editBinding
            const { a, req } = await twoValidators()
            const st = await store(req.hash, facts(req.hash))
            ;(st.content.gcr_edits as unknown[]).push({
                type: "tlsnotary",
                operation: "verifiedStore",
                account: SENDER,
                data: {
                    tokenId: req.hash,
                    proof: "forged",
                    storageType: "onchain",
                    attestationId: "x",
                    serverName: "api.github.com",
                    attestedTimeSec: 1,
                    storedAtHeight: 102,
                },
                txhash: st.hash,
                isRollback: false,
            })

            const out = await a.apply(102, [st])

            expect(out.failedTxs).toEqual([st.hash])
            expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")
        })
    }
})

describe("one request backs one attestation, and a node without a verdict", () => {
    it("refuses a store on a token an identity link used", async () => {
        const { a, req } = await twoValidators()
        const row = a.row(req.hash)!
        a.caches.tlsNotaries.set(req.hash, { ...row, status: "linked", attestationId: "a9" } as GCRTLSNotary)
        const before = a.digest()
        const st = await store(req.hash, facts(req.hash))

        expect(await admissionRefusal(a, 102, st)).toContain("ALREADY_USED")
        const out = await a.apply(102, [st])

        expect(out.failedTxs).toEqual([st.hash])
        expect(a.digest()).toBe(before)
    })

    it("applies token edits in the TLSN identity links' group, in block order", async () => {
        const req = tlsnAdmissionCopy(await request())
        expect(req.ok).toBe(true)
        const linkTx = (sender: string, hash: string): any => ({
            hash,
            content: {
                from_ed25519_address: sender,
                gcr_edits: [{ type: "identity", context: "tlsn", operation: "add", account: sender }],
            },
        })
        const reqTx = (req as { tx: Transaction }).tx
        const groups = HandleGCR.partitionIndependentTxs([
            linkTx("0x" + "a1".repeat(32), "h1"),
            reqTx,
            linkTx("0x" + "c3".repeat(32), "h3"),
        ])
        expect(groups.map(g => g.map(t => t.hash))).toContainEqual(["h1", reqTx.hash, "h3"])
    })

    it("stops the block, not the store, when this node's verifier is not the one the chain pins", async () => {
        const { a, req } = await twoValidators()
        const st = await store(req.hash, facts(req.hash))
        setPresentationVerifierForTests({ wasmSha256: "01".repeat(32), verify: bytes => fakeVerify(bytes) as never })

        const applied = a.apply(102, [st])

        await expect(applied).rejects.toBeInstanceOf(TlsnVerifierUnavailableAtApplyError)
        await expect(a.apply(102, [st])).rejects.toBeInstanceOf(StateReadError)
        expect(tlsnRequestOf(a.row(req.hash))!.status).toBe("pending")
        // Admission refuses it on this node only, with a reason to retry.
        expect(await admissionRefusal(a, 102, st)).toContain("cannot run on this node")
    })
})

describe("before tlsnVerified", () => {
    it("writes no token row: the request keeps its pre-fork behaviour", async () => {
        baseForks()
        const v = new Validator(0)
        const req = await request()

        const out = await v.apply(101, [req])

        expect(out.successfulTxs).toEqual([req.hash])
        expect(v.rows()).toHaveLength(0)
    })
})
