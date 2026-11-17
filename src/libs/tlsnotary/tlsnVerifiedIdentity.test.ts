/**
 * TLSN identity links under the `tlsnVerified` fork, end to end: the RPC
 * admission check (handleIdentityRequest) and block apply (HandleGCR) judge
 * the same transaction with the pinned wasm verifier, the fork's notary keys,
 * the block's time and the authenticated transcript.
 *
 * The golden vectors fix the sender and the tlsn_request their bind header
 * names, so a link here is built by the SDK builder and then given the
 * vector's sender; the tlsn_request itself is a chain row the fake chain
 * reads return. The local vectors come from a test server under a test CA,
 * which the stand-in verifier passes as the root; consensus code uses the
 * compiled-in roots.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import { StateReadError } from "@/libs/blockchain/gcr/stateReadError"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 500 },
}))
const quiet = () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
})
mock.module("src/utilities/logger", quiet)
mock.module("@/utilities/logger", quiet)

/** What the chain holds, as the TLSN rules read it. */
const chain = {
    tipTimeSec: 0,
    requests: new Map<string, Record<string, unknown>>(),
    /** Stored accounts, as the database holds them before the block. */
    stored: [] as { pubkey: string; identities: { web2: Record<string, any[]> } }[],
    failing: false,
}
const chainReads = () => ({
    findTlsnRequest: async (hash: string) => {
        if (chain.failing) throw new StateReadError("tlsn_request lookup", "database down")
        return chain.requests.get(hash) ?? null
    },
    findTlsnLinkHits: async (q: {
        context: string
        userId: string
        attestationId: string
        account: string
        skip: readonly string[]
    }) => {
        if (chain.failing) throw new StateReadError("tlsn linked userId", "database down")
        const others = chain.stored.filter(a => !q.skip.includes(a.pubkey))
        const links = (a: (typeof chain.stored)[number]) => a.identities.web2[q.context] ?? []
        return {
            userIdLinked: others.some(a => a.pubkey !== q.account && links(a).some(l => String(l.userId) === q.userId)),
            attestationUsed: others.some(a => links(a).some(l => l.attestationId === q.attestationId)),
        }
    },
    tipBlockTimestampSec: async () => chain.tipTimeSec,
})
mock.module("@/libs/tlsnotary/tlsnChainReads", chainReads)
mock.module("./tlsnChainReads", chainReads)

const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { getSharedState } = await import("@/utilities/sharedState")
const { withBlockTime } = await import("@/libs/blockchain/gcr/applyTime")
const { demos, viaConfirm, SENDER: SDK_SENDER } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { generateGcrEdits } = await import("@/libs/blockchain/validation/generateGcrEdits")
const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { default: handleIdentityRequest } = await import(
    "@/libs/network/routines/transactions/handleIdentityRequest"
)
const { VERIFIER_WASM_SHA256 } = await import("@/libs/blockchain/testSupport/tlsnVerifiedFixtures")
const { TLSN_VERIFY_WASM_SHA256, TlsnVerifierUnavailableError, TlsnWasmVerifier } = await import("./wasmVerifier")
const { setPresentationVerifierForTests } = await import("./presentationGate")
const { TLSN_IDENTITY_ENDPOINTS, parseBindValue, setTlsnIdentityEndpointsForTests } = await import(
    "./identityPolicy"
)
const { TlsnVerifierUnavailableAtApplyError } = await import("./verifiedIdentity")

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const VECTORS = join(REPO, "testing/tlsn-vectors")
const TEST_ROOT = new Uint8Array(readFileSync(join(VECTORS, "test-ca.der")))
// The trusted secp256k1 test notary of the vectors (spike-notary-k).
const TRUSTED_K256: string = JSON.parse(readFileSync(join(VECTORS, "trusted-notary-keys.json"), "utf8")).find(
    (k: { alg: string }) => k.alg === "k256",
).publicKey

interface Vector {
    name: string
    meta: {
        root: string | null
        nodePolicy: "accept" | "refuse"
        expect: { server: string; method: string; path: string; bind: string }
    }
    hex: string
    output: Record<string, any> | null
}

const vectors: Vector[] = readdirSync(VECTORS)
    .filter(n => existsSync(join(VECTORS, n, "presentation.bin")))
    .sort()
    .map(name => {
        const dir = join(VECTORS, name)
        const out = join(dir, "output.json")
        return {
            name,
            meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")),
            hex: readFileSync(join(dir, "presentation.bin")).toString("hex"),
            output: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null,
        }
    })
const vector = (name: string) => vectors.find(v => v.name === name)!

// Every vector binds to the same sender and tlsn_request.
const BIND = parseBindValue(vectors[0].meta.expect.bind)!
const BIND_SENDER = BIND.sender
const REQUEST_HASH = BIND.requestTxHash
const ATTESTED = vector("valid-local-k256").output!.time as number
const BLOCK_TIME = ATTESTED + 120

const wasm = TlsnWasmVerifier.load()
let useTestRoot = true
let verifyCalls = 0
/** The pinned verifier, with the test CA as root for the local vectors. */
const testVerifier = {
    wasmSha256: TLSN_VERIFY_WASM_SHA256,
    verify: (bytes: Uint8Array, onRefusal: (r: string) => void) => {
        verifyCalls++
        return useTestRoot
            ? wasm.verifyWithTestRoot(bytes, TEST_ROOT, { onRefusal })
            : wasm.verifyPresentation(bytes, { onRefusal })
    },
}

function forkAt(payload: Record<string, unknown> = {}): void {
    getSharedState.forkConfig.tlsnVerified = {
        ...getSharedState.forkConfig.tlsnVerified,
        activationHeight: 0,
        notaryKeys: [{ id: "spike-notary-k", alg: "k256", hex: TRUSTED_K256 }],
        verifierWasmSha256: VERIFIER_WASM_SHA256,
        maxPresentationBytes: 65536,
        freshnessWindowSec: 3600,
        futureSkewSec: 60,
        ...payload,
    } as never
}

/** Endpoints and the chain's tlsn_request for a vector's server and path. */
function serve(v: Vector, request: Record<string, unknown> = {}): void {
    const { server, method, path } = v.meta.expect
    setTlsnIdentityEndpointsForTests({ github: { ...TLSN_IDENTITY_ENDPOINTS.github, server, method, path } })
    useTestRoot = v.meta.root !== null
    chain.requests.set(REQUEST_HASH, {
        hash: REQUEST_HASH,
        status: "confirmed",
        blockNumber: 400,
        sender: BIND_SENDER,
        type: "native",
        nativeOperation: "tlsn_request",
        targetUrl: `https://${server}${path}`,
        ...request,
    })
}

/** The identity of an accepted vector: from its verified response body. */
function claimed(v: Vector): { username: string; userId: string } {
    if (!v.output) return { username: "demos-spike-user", userId: "4242" }
    const recv = Buffer.from(v.output.recv, "hex").toString("latin1")
    const body = JSON.parse(recv.slice(recv.indexOf("\r\n\r\n") + 4))
    return { username: body.login, userId: String(body.id) }
}

const identities = new Identities()

/** An SDK-built TLSN link and its edit, sent as `sender`. */
async function link(opts: {
    hex: string
    username: string
    userId: string
    context?: string
    sender?: string
}): Promise<{ tx: any; edit: any }> {
    const tx: any = await viaConfirm(() =>
        identities.addWeb2IdentityViaTLSN(
            demos,
            (opts.context ?? "github") as never,
            { version: "0.1.0-alpha.12", data: opts.hex, meta: {} } as never,
            createHash("sha256").update(opts.hex).digest("hex"),
            { recv: [], sent: [] } as never,
            [],
            opts.username,
            opts.userId,
            undefined,
            { legacy: true },
        ),
    )
    const edit = JSON.parse(JSON.stringify((await generateGcrEdits(tx)).find(e => e.type === "identity")))
    const sender = opts.sender ?? BIND_SENDER
    tx.content.from_ed25519_address = sender
    edit.account = sender
    return { tx, edit }
}

const account = (pubkey: string, web2: Record<string, any[]> = {}): any => ({ pubkey, identities: { web2 } })

function caches(...accounts: any[]): any {
    return {
        accounts: new Map(accounts.map(a => [a.pubkey, a])),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

const admit = (tx: any) => handleIdentityRequest(tx, tx.content.from_ed25519_address)

const applyAt = (blockTimeSec: number, edit: any, entities: any) =>
    withBlockTime(blockTimeSec, () => HandleGCR.applyGCREdit(structuredClone(edit), entities, false, false))

/** Admission and apply of one link; both verdicts and the account after. */
async function judgeBoth(
    opts: Parameters<typeof link>[0],
    blockTimeSec = BLOCK_TIME,
    holder = account(opts.sender ?? BIND_SENDER),
    others: any[] = [],
) {
    const { tx, edit } = await link(opts)
    const admitted = await admit(tx)
    const applied = await applyAt(blockTimeSec, edit, caches(holder, ...others))
    return { admitted, applied, holder, edit, tx }
}

let saved: { forkConfig: any; lastBlockNumber: number }
beforeEach(() => {
    saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = 500
    forkAt()
    chain.tipTimeSec = BLOCK_TIME
    chain.requests.clear()
    chain.stored = []
    chain.failing = false
    verifyCalls = 0
    setPresentationVerifierForTests(testVerifier)
    serve(vector("valid-local-k256"))
})
afterEach(() => {
    getSharedState.forkConfig = saved.forkConfig
    getSharedState.lastBlockNumber = saved.lastBlockNumber
    setPresentationVerifierForTests(null)
    setTlsnIdentityEndpointsForTests(null)
})

const K256 = () => vector("valid-local-k256")

describe("golden vectors through admission and apply", () => {
    for (const v of vectors) {
        // The fork lists secp256k1 keys only (the prover never asks for
        // P-256), so a P-256 vector the spike accepted is refused here.
        const p256 = v.output?.verifyingKey?.alg === "p256"
        const accept = v.meta.nodePolicy === "accept" && !p256
        it(`${v.name}: ${accept ? "links" : "is refused"}${p256 && v.meta.nodePolicy === "accept" ? " (P-256 key)" : ""}`, async () => {
            serve(v)
            const at = (v.output?.time as number | undefined) ?? ATTESTED
            chain.tipTimeSec = at + 120
            const { admitted, applied, holder } = await judgeBoth({ hex: v.hex, ...claimed(v) }, at + 120)
            expect(admitted.success).toBe(accept)
            expect(applied.success).toBe(accept)
            const links = holder.identities.web2.github ?? []
            if (accept) {
                expect(links).toHaveLength(1)
                expect(links[0]).toMatchObject({
                    userId: claimed(v).userId,
                    username: claimed(v).username,
                    proofType: "tlsn",
                    attestationId: v.output!.attestationId,
                })
            } else {
                expect(links).toHaveLength(0)
                if (p256 && v.output!.serverName) expect(admitted.message).toContain("not k256")
            }
        })
    }

    it("the 'no-server-identity' vector is refused for its missing server name", async () => {
        const v = vector("no-server-identity")
        serve(v)
        const { admitted, applied } = await judgeBoth({ hex: v.hex, ...claimed(v) })
        expect(admitted.message).toContain("server identity")
        expect(applied.message).toContain("server identity")
    })
})

describe("notary keys and time", () => {
    it("refuses a key the fork does not list, though the presentation verifies", async () => {
        for (const name of ["wrong-notary-key", "default-notary-k256"]) {
            const v = vector(name)
            serve(v)
            const { admitted, applied } = await judgeBoth({ hex: v.hex, ...claimed(v) }, v.output!.time + 120)
            expect(admitted.success).toBe(false)
            expect(applied.success).toBe(false)
        }
        const { applied } = await judgeBoth({ hex: vector("default-notary-k256").hex, ...claimed(K256()) })
        expect(applied.message).toContain("not signed by a notary key the chain lists")
    })

    it("refuses the trusted key once the fork no longer lists it", async () => {
        forkAt({ notaryKeys: [{ id: "other", alg: "k256", hex: vector("default-notary-k256").output!.verifyingKey.hex }] })
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(admitted.success).toBe(false)
        expect(applied.message).toContain("not signed by a notary key the chain lists")
    })

    it("refuses a stale attestation, judged by the block time", async () => {
        const late = ATTESTED + 3600 + 1
        chain.tipTimeSec = late
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) }, late)
        expect(admitted.message).toContain("stale")
        expect(applied.message).toContain("stale")

        const edge = await judgeBoth({ hex: K256().hex, ...claimed(K256()) }, ATTESTED + 3600)
        expect(edge.applied.success).toBe(true)
    })

    it("refuses an attestation later than the block time plus the skew", async () => {
        const early = ATTESTED - 61
        chain.tipTimeSec = early
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) }, early)
        expect(admitted.message).toContain("future")
        expect(applied.message).toContain("future")

        const edge = await judgeBoth({ hex: K256().hex, ...claimed(K256()) }, ATTESTED - 60)
        expect(edge.applied.success).toBe(true)
    })

    it("judges apply by the block's time and admission by the tip's, never the wall clock", async () => {
        const { tx, edit } = await link({ hex: K256().hex, ...claimed(K256()) })
        const realNow = Date.now
        Date.now = () => {
            throw new Error("the wall clock was read")
        }
        try {
            expect((await admit(tx)).success).toBe(true)
            expect((await applyAt(BLOCK_TIME, edit, caches(account(BIND_SENDER)))).success).toBe(true)
        } finally {
            Date.now = realNow
        }
    })

    it("refuses an oversized presentation before the verifier sees it", async () => {
        forkAt({ maxPresentationBytes: 1024 })
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(admitted.message).toContain("larger than the 1024 bytes")
        expect(applied.message).toContain("larger than the 1024 bytes")
        expect(verifyCalls).toBe(0)
    })
})

describe("transcript rules", () => {
    /** valid-local-k256 as the verifier reports it, changed by `edit`. */
    function forged(edit: (out: Record<string, any>) => void) {
        const out = structuredClone(K256().output!)
        edit(out)
        setPresentationVerifierForTests({
            wasmSha256: TLSN_VERIFY_WASM_SHA256,
            verify: () => ({ ok: true, out: out as never, raw: JSON.stringify(out) }),
        })
    }

    it("refuses a presentation that reveals the Authorization value", async () => {
        forged(out => {
            const sent = Buffer.from(out.sent, "hex")
            const at = sent.indexOf("authorization: ") + "authorization: ".length
            const end = sent.indexOf("\r\n", at)
            sent.fill("x", at, end)
            out.sent = sent.toString("hex")
            out.sentAuthed = [[0, sent.length]]
        })
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(admitted.message).toContain("reveals the authorization header value")
        expect(applied.message).toContain("reveals the authorization header value")
    })

    it("the vector itself hides the Authorization value", async () => {
        const sent = Buffer.from(K256().output!.sent, "hex").toString("latin1")
        expect(sent).toContain("authorization: ")
        const { applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(applied.success).toBe(true)
    })

    it("refuses a bind header naming another sender than the transaction's", async () => {
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()), sender: SDK_SENDER })
        expect(admitted.message).toContain("X-Demos-Bind names another account")
        expect(applied.message).toContain("X-Demos-Bind names another account")
    })

    it("refuses a bind header for another context", async () => {
        setTlsnIdentityEndpointsForTests({
            discord: { ...TLSN_IDENTITY_ENDPOINTS.github, server: "api.demos-spike.test", path: "/user" },
        })
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()), context: "discord" })
        expect(admitted.message).toContain("X-Demos-Bind names github")
        expect(applied.message).toContain("X-Demos-Bind names github")
    })

    it("refuses the real endpoint table: the vector's server and path are not GitHub's", async () => {
        setTlsnIdentityEndpointsForTests(null)
        const { applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(applied.message).toContain("links come from api.github.com")

        const gh = vector("valid-github")
        serve(gh)
        setTlsnIdentityEndpointsForTests(null)
        const real = await judgeBoth({ hex: gh.hex, ...claimed(gh) }, gh.output!.time + 120)
        expect(real.applied.message).toContain("GET /users/octocat, github links need GET /user")
    })

    it("refuses a claim that differs from the verified response", async () => {
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, username: "someone-else", userId: "4242" })
        expect(admitted.message).toContain("Username mismatch")
        expect(applied.message).toContain("Username mismatch")
    })

    it("refuses Telegram, whatever the presentation", async () => {
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()), context: "telegram" })
        expect(admitted.success).toBe(false)
        expect(admitted.message).toContain("telegram cannot be linked with a TLSNotary proof")
        expect(applied.message).toContain("telegram cannot be linked with a TLSNotary proof")
    })

    it("ignores the client's own copy of the response", async () => {
        const { tx, edit } = await link({ hex: K256().hex, ...claimed(K256()) })
        edit.data.data.revealedRecv = [1, 2, 3]
        edit.data.data.recvHash = "not a hash"
        expect((await applyAt(BLOCK_TIME, edit, caches(account(BIND_SENDER)))).success).toBe(true)
        expect((await admit(tx)).success).toBe(true)
    })
})

describe("the tlsn_request the bind header names", () => {
    const cases: [string, Record<string, unknown> | null, string][] = [
        ["missing", null, "names no tlsn_request on chain"],
        ["failed in its block", { status: "failed" }, "not a confirmed tlsn_request"],
        ["another native operation", { nativeOperation: "tlsn_store" }, "not a confirmed tlsn_request"],
        ["another sender's", { sender: SDK_SENDER }, "tlsn_request of another account"],
        ["for another server", { targetUrl: "https://example.com/user" }, "tlsn_request for another server"],
    ]
    for (const [label, change, message] of cases) {
        it(`refuses a request that is ${label}`, async () => {
            if (change === null) chain.requests.clear()
            else serve(K256(), change)
            const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
            expect(admitted.message).toContain(message)
            expect(applied.message).toContain(message)
        })
    }
})

describe("replay and uniqueness", () => {
    // A byte in the unused MerkleProof.alg field: flipped, the presentation
    // still verifies to the same output (spike F3).
    const MALLEABLE_OFFSET = 443

    function malleated(): string {
        const bytes = Buffer.from(K256().hex, "hex")
        bytes[MALLEABLE_OFFSET] ^= 1
        return bytes.toString("hex")
    }

    it("keys replay on the attestation id, which malleated bytes keep", async () => {
        const other = malleated()
        expect(other).not.toBe(K256().hex)
        const a = wasm.verifyWithTestRoot(Buffer.from(K256().hex, "hex"), TEST_ROOT) as any
        const b = wasm.verifyWithTestRoot(Buffer.from(other, "hex"), TEST_ROOT) as any
        expect(b.ok).toBe(true)
        expect(b.raw).toBe(a.raw)

        const holder = account(BIND_SENDER)
        const first = await judgeBoth({ hex: K256().hex, ...claimed(K256()) }, BLOCK_TIME, holder)
        expect(first.applied.success).toBe(true)

        // A later block: the link is stored, and the same attestation in new
        // bytes is refused as a replay, not as a duplicate proof hash.
        chain.stored = [holder]
        const again = await judgeBoth({ hex: other, ...claimed(K256()) }, BLOCK_TIME + 7, holder)
        expect(again.admitted.message).toContain("this attestation already linked an identity")
        expect(again.applied.message).toContain("this attestation already linked an identity")
        expect(holder.identities.web2.github).toHaveLength(1)
    })

    it("refuses an attestation another account stored", async () => {
        chain.stored = [account("0x" + "ab".repeat(32), { github: [{ userId: "1", attestationId: K256().output!.attestationId }] })]
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(admitted.message).toContain("this attestation already linked an identity")
        expect(applied.message).toContain("this attestation already linked an identity")
    })

    it("refuses a web2 account another account has linked", async () => {
        chain.stored = [account("0x" + "ab".repeat(32), { github: [{ userId: 4242, username: "x", proofType: "tlsn" }] })]
        const { admitted, applied } = await judgeBoth({ hex: K256().hex, ...claimed(K256()) })
        expect(admitted.message).toContain("github account 4242 is linked to another account")
        expect(applied.message).toContain("github account 4242 is linked to another account")
    })

    it("refuses a web2 account another account of the same block linked first", async () => {
        const other = account("0x" + "ab".repeat(32), { github: [{ userId: "4242", username: "x", proofType: "tlsn" }] })
        // The database still holds the other account without the link.
        chain.stored = [account(other.pubkey)]
        const { applied } = await judgeBoth(
            { hex: K256().hex, ...claimed(K256()) },
            BLOCK_TIME,
            account(BIND_SENDER),
            [other],
        )
        expect(applied.message).toContain("github account 4242 is linked to another account")
    })

    it("applies TLSN and web2 links of different senders in one group, in block order", () => {
        const tx = (sender: string, context: string, hash: string): any => ({
            hash,
            content: {
                from_ed25519_address: sender,
                gcr_edits: [{ type: "identity", context, operation: "add", account: sender }],
            },
        })
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0x" + "a1".repeat(32), "tlsn", "h1"),
            tx("0x" + "b2".repeat(32), "web2", "h2"),
            tx("0x" + "c3".repeat(32), "tlsn", "h3"),
            tx("0x" + "d4".repeat(32), "xm", "h4"),
        ])
        expect(groups.map(g => g.map(t => t.hash))).toContainEqual(["h1", "h2", "h3"])
        expect(groups.map(g => g.map(t => t.hash))).toContainEqual(["h4"])
    })
})

describe("a node without a verdict", () => {
    const unavailable = () =>
        setPresentationVerifierForTests({
            wasmSha256: TLSN_VERIFY_WASM_SHA256,
            verify: () => {
                throw new TlsnVerifierUnavailableError("instantiate: out of memory")
            },
        })

    it("refuses at admission with a retryable reason", async () => {
        unavailable()
        const { tx } = await link({ hex: K256().hex, ...claimed(K256()) })
        const result: any = await admit(tx)
        expect(result.success).toBe(false)
        expect(result.retryable).toBe(true)
        expect(result.message).toContain("verifier is unavailable on this node; try again later")
    })

    it("does not apply the block, instead of failing the transaction on this node", async () => {
        unavailable()
        const { edit } = await link({ hex: K256().hex, ...claimed(K256()) })
        const holder = account(BIND_SENDER)
        const applying = applyAt(BLOCK_TIME, edit, caches(holder))
        await expect(applying).rejects.toBeInstanceOf(StateReadError)
        await expect(applyAt(BLOCK_TIME, edit, caches(holder))).rejects.toBeInstanceOf(
            TlsnVerifierUnavailableAtApplyError,
        )
        expect(holder.identities.web2.github ?? []).toHaveLength(0)
    })

    it("has no verdict when its verifier is not the one the chain pins", async () => {
        forkAt({ verifierWasmSha256: createHash("sha256").update("another verifier").digest("hex") })
        const { tx, edit } = await link({ hex: K256().hex, ...claimed(K256()) })
        const admitted: any = await admit(tx)
        expect(admitted.retryable).toBe(true)
        expect(admitted.message).toContain("is not the one the chain pins")
        await expect(applyAt(BLOCK_TIME, edit, caches(account(BIND_SENDER)))).rejects.toBeInstanceOf(StateReadError)
        expect(verifyCalls).toBe(0)
    })

    it("does not apply the block when a chain read fails", async () => {
        chain.failing = true
        const { tx, edit } = await link({ hex: K256().hex, ...claimed(K256()) })
        expect(((await admit(tx)) as any).retryable).toBe(true)
        await expect(applyAt(BLOCK_TIME, edit, caches(account(BIND_SENDER)))).rejects.toBeInstanceOf(StateReadError)
    })
})

describe("before the fork", () => {
    it("keeps the structure-only path, which tlsnProofEnforcement refuses", async () => {
        getSharedState.forkConfig.tlsnVerified.activationHeight = null
        getSharedState.forkConfig.tlsnProofEnforcement.activationHeight = 0
        const { tx } = await link({ hex: K256().hex, ...claimed(K256()) })
        const result = await admit(tx)
        expect(result.success).toBe(false)
        expect(result.message).toContain("does not verify the notary signature")
        expect(verifyCalls).toBe(0)
    })
})
