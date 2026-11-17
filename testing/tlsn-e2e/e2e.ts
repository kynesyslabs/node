/**
 * TLSNotary under tlsnVerified, end to end on 4 validators. Run through
 * run.sh, which boots the stack and exports the run's ports and paths.
 *
 * The SDK does every client part: it sends and waits for the tlsn_request,
 * signs the proxy request, attests real public data from api.github.com in
 * headless Chromium through a node relay and a notary, and builds the store
 * and identity transactions. The harness only reads what each node holds
 * and compares the four.
 */
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Demos, DemosTransactions, bodyBoundAuthHeaders } from "@kynesyslabs/demosdk/websdk"
import { TLSNotaryService, calculateStorageFee } from "@kynesyslabs/demosdk/tlsnotary/service"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import { verifyPresentation } from "../../src/libs/tlsnotary/wasmVerifier"
import {
    type Admission,
    type Node,
    LOG_DIR,
    NODES,
    NOTARIES,
    RUN_DIR,
    SDK_TREE,
    TRUSTED_KEYS,
    blockAt,
    blockTimeMs,
    check,
    checks,
    client,
    compose,
    confirmOn,
    evidence,
    forgetColumns,
    json,
    loadWallets,
    node,
    nodeCall,
    note,
    psql,
    quantiles,
    quiescentStates,
    relayDialUrl,
    say,
    skip,
    sleep,
    startLocalRelay,
    stateDifferences,
    step,
    tips,
    tlsnProof,
    tlsnRow,
    tlsnRows,
    waitAll,
    waitHeight,
    waitIncluded,
} from "./lib"
import { type AttestInput, startProver } from "./prover"

const GITHUB = "https://api.github.com"
const STORE_URL = `${GITHUB}/users/octocat`
const ID_URL = `${GITHUB}/user`
const UA = { "User-Agent": "demos-tlsn-e2e" }
// Shaped like a credential so the node's header rule fires; GitHub answers 401.
const FAKE_AUTH = { Authorization: "Bearer demos-tlsn-e2e-not-a-credential" }
const TTL_BLOCKS = 500
const GH_TOKEN = process.env.TLSN_E2E_GITHUB_TOKEN ?? ""
const redact = (s: string) => (GH_TOKEN ? s.split(GH_TOKEN).join("<redacted>") : s)

const wallets = loadWallets()
const alice = wallets.alice
const bob = wallets.bob
const bare = (h: string) => h.toLowerCase().replace(/^0x/, "")
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const runStart = Date.now()

// ---- metrics -------------------------------------------------------------------

interface TlsnTx {
    kind: string
    hash: string
    via: string
    submittedAt: number
    includedAllAt: number | null
    gcrAllAt: number | null
    block: number | null
}
const tlsnTxs: TlsnTx[] = []
const admissionMs: { kind: string; node: string; ms: number; valid: boolean }[] = []
const verifyMs: { name: string; ms: number; ok: boolean }[] = []
const attestMs: { name: string; ms: number; ok: boolean }[] = []

// ---- SDK helpers -------------------------------------------------------------

const service = async (w: typeof alice, n: Node) => new TLSNotaryService(await client(w, n))

/** A tlsn_request through `via`: confirm, broadcast, then its inclusion and token row on all four. */
async function sendRequest(kind: string, w: typeof alice, via: Node, url: string) {
    const d = await client(w, via)
    const tx = await (await service(w, via) as any).createTlsnRequestTransaction(url)
    const submittedAt = Date.now()
    const validity: any = await d.confirm(tx)
    if (validity?.response?.data?.valid !== true) {
        throw new Error(`${kind}: ${via.name} refused the tlsn_request: ${json(validity?.response?.data?.message ?? validity)}`)
    }
    const hash = bare(validity.response.data.transaction?.hash ?? tx.hash)
    const sent: any = await d.broadcast(validity)
    if (sent?.result !== 200) throw new Error(`${kind}: broadcast refused: ${json(sent).slice(0, 400)}`)
    return await followTx({ kind, hash, via: via.name, submittedAt }, "pending")
}

/** Waits for `hash` on all four and for its token row to reach `status` on all four. */
async function followTx(t: { kind: string; hash: string; via: string; submittedAt: number }, status: string | null, tokenId = t.hash) {
    const inc = await waitIncluded(t.hash, 120_000)
    const states = [...inc.values()]
    const rec: TlsnTx = {
        ...t,
        includedAllAt: inc.size === NODES.length ? Math.max(...states.map(s => s.at)) : null,
        gcrAllAt: null,
        block: states[0]?.block ?? null,
    }
    if (status) {
        const rows = await waitAll(n => tlsnRow(n, tokenId), r => r?.status === status, 60_000)
        rec.gcrAllAt = rows?.at ?? null
    }
    tlsnTxs.push(rec)
    note(`${t.kind} ${t.hash}: ${json([...inc.entries()])}`)
    return rec
}

async function openProxy(w: typeof alice, n: Node, tokenId: string, targetUrl: string) {
    const d = await client(w, n)
    return (await d.bodyBoundNodeCall("requestTLSNproxy", { tokenId, targetUrl })) as any
}

/** Confirms one signed transaction on every validator. */
async function confirmEverywhere(kind: string, w: typeof alice, tx: any): Promise<Admission[]> {
    const out: Admission[] = []
    for (const n of NODES) {
        const a = await confirmOn(await client(w, n), tx, n)
        admissionMs.push({ kind, node: n.name, ms: a.ms, valid: a.valid })
        out.push(a)
    }
    return out
}

/** Why a broadcast was refused, or "" when the node took the tx. */
function broadcastRefusal(sent: any): string {
    if (sent?.result === 200) return ""
    return String(sent?.extra?.error ?? sent?.response?.message ?? json(sent)).slice(0, 600)
}

/**
 * Submits one signed transaction to every validator: confirm, then
 * broadcast. Confirm checks only the signature and the fee; a TLSNotary
 * transaction is verified and simulated against the token row when it is
 * broadcast, so that is where a node must refuse it.
 */
async function submitEverywhere(kind: string, w: typeof alice, tx: any): Promise<Admission[]> {
    const out: Admission[] = []
    for (const n of NODES) {
        const d = await client(w, n)
        const t0 = Date.now()
        let a: Admission
        try {
            const validity: any = await d.confirm(tx)
            if (validity?.response?.data?.valid !== true) {
                a = { node: n.name, valid: false, message: `confirm: ${String(validity?.response?.data?.message ?? json(validity)).slice(0, 600)}`, ms: Date.now() - t0 }
            } else {
                const why = broadcastRefusal(await d.broadcast(validity))
                a = { node: n.name, valid: why === "", message: why, ms: Date.now() - t0 }
            }
        } catch (error) {
            a = { node: n.name, valid: false, message: `threw: ${String(error).slice(0, 600)}`, ms: Date.now() - t0 }
        }
        admissionMs.push({ kind, node: n.name, ms: a.ms, valid: a.valid })
        out.push(a)
    }
    return out
}

/** All four refused, for the same reason, and that reason matches `expect`. */
function refusedEverywhere(id: string, title: string, answers: Admission[], expect: RegExp) {
    evidence(`negative-${id}`, answers)
    const reasons = new Set(answers.map(a => a.message))
    const ok = answers.length === NODES.length && answers.every(a => !a.valid) && reasons.size === 1 && expect.test(answers[0].message)
    return check(id, title, ok, ok ? answers[0].message.slice(0, 220) : json(answers.map(a => `${a.node}: ${a.valid ? "ADMITTED" : a.message}`)).slice(0, 900))
}

async function storeTx(w: typeof alice, via: Node, tokenId: string, proof: string) {
    const fee = calculateStorageFee(Math.ceil(proof.length / 1024))
    return await (await service(w, via) as any).createTlsnStoreTransaction(tokenId, proof, "onchain", fee)
}

function localVerify(name: string, presentation: any) {
    const t0 = performance.now()
    const r = verifyPresentation(new Uint8Array(Buffer.from(presentation.data, "hex")))
    const ms = performance.now() - t0
    verifyMs.push({ name, ms, ok: r.ok })
    return { ...r, ms }
}

// ---- the run ----------------------------------------------------------------------

const prover = await startProver(SDK_TREE, RUN_DIR, s => {
    if (!s.startsWith("[browser:info]") && !s.startsWith("[browser:debug]")) writeFileSync(join(LOG_DIR, "prover.log"), redact(s) + "\n", { flag: "a" })
})

async function attest(name: string, input: AttestInput) {
    const out = await prover.attest(input)
    attestMs.push({ name, ms: out.ms, ok: out.ok })
    note(`attest ${name}: ok=${out.ok} ${Math.round(out.ms)} ms ${out.error ? redact(out.error).slice(0, 400) : ""}`)
    if (!out.ok) throw new Error(`attest ${name} failed: ${redact(out.error ?? "").slice(0, 600)}`)
    evidence(`presentation-${name}`, { meta: out.presentation?.meta, version: out.presentation?.version, bytes: out.presentation.data.length / 2, sha256: sha256(out.presentation.data) })
    return out
}

const sentText = (v: any) => String(v?.sent ?? "")
const binding = (purpose: string, sender: string, requestTxHash: string) => ({ purpose, sender, requestTxHash })

const tok: Record<string, { tokenId: string; requestHeight?: number; expiresAtHeight?: number; proxyUrl?: string }> = {}
const pres: Record<string, any> = {}

await step("00-boot", async () => {
    const t = await waitHeight(2, NODES, 360_000)
    check("boot.chain", "all four validators produce blocks", t.every(x => x >= 2), `tips ${t.join("/")}`)
    const info = await Promise.all(NODES.map(n => nodeCall(n, "tlsnotary.getInfo")))
    evidence("tlsnotary-getInfo", info)
    const net = await (await client(alice, node(1))).getNetworkInfo()
    evidence("network-info", net)
    const fork = (net as any)?.forks?.tlsnVerified
    check("boot.fork", "tlsnVerified is active from block 0", fork?.activated === true || fork?.active === true || fork?.activationHeight === 0, json(fork).slice(0, 300))
    say(`notaries: ${NOTARIES.map(n => `notary-${n.k}${n.trusted ? "" : " (untrusted)"} ${n.publicKey}`).join(", ")}`)
})

await step("01-request", async () => {
    // The SDK's own path: request, wait for inclusion, open a proxy (on the entry node).
    const svc = await service(alice, node(1))
    const t0 = Date.now()
    const r = await svc.requestAttestation({ targetUrl: STORE_URL })
    const sdkMs = Date.now() - t0
    const t1 = bare(r.txHash)
    tok.main = { tokenId: t1 }
    // The session the SDK opened on node-1, used for the second attestation.
    tok.mainSdk = { tokenId: t1, proxyUrl: r.proxyUrl }
    const rec = await followTx({ kind: "tlsn_request", hash: t1, via: "node-1", submittedAt: t0 }, "pending")
    note(`requestAttestation answered in ${sdkMs} ms: ${json({ ...r, proxyUrl: r.proxyUrl })}`)
    check("1.sdk", "SDK requestAttestation returns the request hash as token and a proxy", bare(r.tokenId) === t1 && /^wss?:\/\//.test(r.proxyUrl), `token ${t1}, proxy ${r.proxyUrl}, ${sdkMs} ms`)
    const rows = tlsnRows(t1)
    evidence("token-main-rows", rows)
    const r0 = rows[0]
    const same = rows.every(x => json(x) === json(r0))
    const shape =
        r0 !== null &&
        r0.status === "pending" &&
        bare(r0.owner) === bare(alice.address) &&
        r0.domain === "api.github.com" &&
        Number(r0.expiresAtHeight) - Number(r0.requestHeight) === TTL_BLOCKS
    check("1.token", "tlsn_request is an on-chain token, identical on all four", same && shape, `${json(r0)} (to GCR on all four in ${rec.gcrAllAt ? rec.gcrAllAt - rec.submittedAt : "?"} ms)`)
    tok.main.requestHeight = Number(r0?.requestHeight)
    tok.main.expiresAtHeight = Number(r0?.expiresAtHeight)
    const views = await Promise.all(NODES.map(n => nodeCall(n, "tlsnotary.getToken", { tokenId: t1 })))
    evidence("token-main-getToken", views)
    check("1.read", "every node serves the token as pending", views.every(v => v.response?.token?.status === "pending"), views.map(v => v.response?.token?.status).join("/"))

    // More tokens, each through another entry node.
    const more: [string, Node, string][] = [
        ["expiry", node(2), STORE_URL],
        ["notary2", node(3), STORE_URL],
        ["neg", node(4), STORE_URL],
        ["idneg", node(1), ID_URL],
    ]
    if (GH_TOKEN) more.push(["id", node(2), ID_URL])
    for (const [label, via, url] of more) {
        const rec2 = await sendRequest(`tlsn_request:${label}`, alice, via, url)
        const row = tlsnRow(node(1), rec2.hash)
        tok[label] = { tokenId: rec2.hash, requestHeight: Number(row?.requestHeight), expiresAtHeight: Number(row?.expiresAtHeight) }
        check(`1.token.${label}`, `tlsn_request ${label} via ${via.name} is a pending token on all four`, rec2.gcrAllAt !== null, `${rec2.hash} at block ${rec2.block}`)
    }
    evidence("tokens", tok)
})

await step("02-proxy", async () => {
    // On another node than the one that took the request (node-1).
    const r = await openProxy(alice, node(2), tok.main.tokenId, STORE_URL)
    evidence("proxy-main", r)
    const url = r?.response?.websocketProxyUrl
    const port = url ? Number(new URL(url).pathname.split("/")[2]) : NaN
    const inWindow = port >= Number(process.env.RELAY_MIN_2) && port <= Number(process.env.RELAY_MAX_2)
    check("2.session", "signed requestTLSNproxy on node-2 opens a relay session", r?.result === 200 && typeof url === "string" && inWindow, `${url} retriesLeft=${r?.response?.retriesLeft}`)
    tok.main.proxyUrl = url
})

await step("03-attest", async () => {
    const t1 = tok.main.tokenId
    const out = await attest("main", {
        notaryUrl: NOTARIES[0].url,
        proxyUrl: relayDialUrl(tok.main.proxyUrl!),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("store", alice.address, t1),
        request: { url: STORE_URL, headers: UA },
    })
    pres.main = out.presentation
    const sent = sentText(out.verification)
    const bind = `x-demos-bind: demos-tlsn:v1:store:${alice.address}:${t1}`
    check(
        "3.attest",
        "SDK attests api.github.com through the node-2 relay and notary-1",
        out.verification?.serverName === "api.github.com" && sent.toLowerCase().includes(bind.toLowerCase()) && !/authorization/i.test(sent),
        `${Math.round(out.ms)} ms, ${out.presentation.data.length / 2} bytes, server ${out.verification?.serverName}`,
    )
    evidence("attest-main-sent", { sent: sent.slice(0, 1200), recvHead: String(out.verification?.recv ?? "").slice(0, 400) })
    const lv = localVerify("main", out.presentation)
    check("3.verify", "the pinned node verifier accepts the presentation", lv.ok, `${lv.ms.toFixed(1)} ms`)
    const sdkVerify = await prover.verify(out.presentation, TRUSTED_KEYS, true)
    check("3.sdkverify", "SDK TLSNotary.verify accepts it with the trusted keys", sdkVerify.ok, sdkVerify.error ?? "")
    const bare_ = await prover.verify(out.presentation, TRUSTED_KEYS, false)
    evidence("sdk-verify-without-global-buffer", bare_)
    note(`SDK verify without a global Buffer: ${json(bare_).slice(0, 300)}`)

    // The session the SDK's requestAttestation opened on node-1, with notary-2.
    const second = await attest("main-second", {
        notaryUrl: NOTARIES[1].url,
        proxyUrl: relayDialUrl(tok.mainSdk.proxyUrl!),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("store", alice.address, t1),
        request: { url: STORE_URL, headers: UA },
    })
    pres.mainSecond = second.presentation
    localVerify("main-second", second.presentation)

    const p2 = await openProxy(alice, node(3), tok.notary2.tokenId, STORE_URL)
    pres.notary2 = (await attest("notary2", {
        notaryUrl: NOTARIES[1].url,
        proxyUrl: relayDialUrl(p2?.response?.websocketProxyUrl),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("store", alice.address, tok.notary2.tokenId),
        request: { url: STORE_URL, headers: UA },
    })).presentation
    check("3.notary2", "SDK attests through the node-3 relay and notary-2", !!pres.notary2 && localVerify("notary2", pres.notary2).ok)

    const pe = await openProxy(alice, node(4), tok.expiry.tokenId, STORE_URL)
    pres.expiry = (await attest("expiry", {
        notaryUrl: NOTARIES[1].url,
        proxyUrl: relayDialUrl(pe?.response?.websocketProxyUrl),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("store", alice.address, tok.expiry.tokenId),
        request: { url: STORE_URL, headers: UA },
    })).presentation
    check("3.expiry", "presentation for the expiry token made while it is live (node-4 relay, notary-2)", !!pres.expiry && localVerify("expiry", pres.expiry).ok)
})

await step("04-identity", async () => {
    if (!GH_TOKEN) {
        skip(
            "4.link",
            "tlsn_identity_assign applied on all four with one link and attestationId",
            "GitHub's GET /user (the only github link endpoint) answers 200 only with an OAuth token; the run uses no credentials. Set TLSN_E2E_GITHUB_TOKEN to run it. The link rules are exercised by the identity negatives in step 6.",
        )
        return
    }
    const ti = tok.id.tokenId
    const p = await openProxy(alice, node(3), ti, ID_URL)
    const out = await attest("identity", {
        notaryUrl: NOTARIES[0].url,
        proxyUrl: relayDialUrl(p?.response?.websocketProxyUrl),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("github", alice.address, ti),
        request: { url: ID_URL, headers: { ...UA, Authorization: `Bearer ${GH_TOKEN}` } },
    })
    const recv = String(out.verification?.recv ?? "")
    const body = JSON.parse(recv.slice(recv.indexOf("\r\n\r\n") + 4).replace(/X/g, "") || "{}")
    const d = await client(alice, node(4))
    const validity: any = await new Identities().addWeb2IdentityViaTLSN(
        d,
        "github",
        out.presentation,
        sha256(recv),
        { recv: [], sent: [] } as any,
        [],
        String(body.login),
        String(body.id),
    )
    if (validity?.response?.data?.valid !== true) {
        check("4.link", "tlsn_identity_assign admitted", false, json(validity?.response?.data ?? validity).slice(0, 600))
        return
    }
    const hash = bare(validity.response.data.transaction.hash)
    const t0 = Date.now()
    await d.broadcast(validity)
    const rec = await followTx({ kind: "tlsn_identity_assign", hash, via: "node-4", submittedAt: t0 }, "linked", ti)
    const links = NODES.map(n => psql(n.db, `select identities->'web2'->'github' from gcr_main where pubkey = '${alice.address}'`))
    evidence("identity-links", links)
    const ids = links.map(l => (JSON.parse(l || "[]") as any[]).map(x => `${x.userId}:${x.attestationId}`).join(","))
    const states = await quiescentStates()
    check(
        "4.link",
        "tlsn_identity_assign applied on all four with one link and attestationId",
        rec.gcrAllAt !== null && new Set(ids).size === 1 && ids[0].length > 0 && stateDifferences(states).length === 0,
        `${ids[0]}; ${stateDifferences(states).join("; ")}`,
    )
})

await step("05-store", async () => {
    // The SDK's public path for the main token.
    const svc = await service(alice, node(3))
    const proof = JSON.stringify(pres.main)
    const t0 = Date.now()
    const r = await svc.storeProof(tok.main.tokenId, proof, { storage: "onchain" })
    const hash = bare(r.txHash)
    const rec = await followTx({ kind: "tlsn_store", hash, via: "node-3", submittedAt: t0 }, "stored", tok.main.tokenId)
    const rows = tlsnRows(tok.main.tokenId)
    evidence("store-main-rows", rows)
    const canonical = JSON.stringify({ version: pres.main.version, data: pres.main.data })
    const proofs = NODES.map(n => tlsnProof(n, tok.main.tokenId))
    check(
        "5.store",
        "tlsn_store onchain applied: token stored, same row on all four",
        rec.gcrAllAt !== null && rows.every(x => json(x) === json(rows[0])) && rows[0]?.status === "stored" && rows[0]?.storageType === "onchain" && /^[0-9a-f]{32,64}$/.test(rows[0]?.attestationId ?? ""),
        `${json(rows[0])} (to GCR on all four in ${rec.gcrAllAt ? rec.gcrAllAt - t0 : "?"} ms)`,
    )
    check("5.read", "the stored proof reads back as the presentation on all four", proofs.every(p => p === canonical), `${canonical.length} chars`)
    const views = await Promise.all(NODES.map(n => nodeCall(n, "tlsnotary.getToken", { tokenId: tok.main.tokenId })))
    check("5.token", "every node serves the token as stored", views.every(v => v.response?.token?.status === "stored"), views.map(v => v.response?.token?.status).join("/"))
    pres.mainStoreTxHash = hash

    // notary-2's presentation, admitted by all four first.
    const tx = await storeTx(alice, node(4), tok.notary2.tokenId, JSON.stringify(pres.notary2))
    const answers = await confirmEverywhere("tlsn_store", alice, tx)
    evidence("store-notary2-admission", answers)
    check("5.admit", "all four admit the notary-2 store", answers.every(a => a.valid), answers.map(a => `${a.node} ${a.ms} ms`).join(", "))
    const d = await client(alice, node(4))
    const validity: any = await d.confirm(tx)
    const t2 = Date.now()
    const why = broadcastRefusal(await d.broadcast(validity))
    admissionMs.push({ kind: "tlsn_store-broadcast", node: "node-4", ms: Date.now() - t2, valid: why === "" })
    if (why) throw new Error(`node-4 refused the notary-2 store at broadcast: ${why}`)
    const rec2 = await followTx({ kind: "tlsn_store", hash: bare(validity.response.data.transaction?.hash ?? tx.hash), via: "node-4", submittedAt: t2 }, "stored", tok.notary2.tokenId)
    const rows2 = tlsnRows(tok.notary2.tokenId)
    check("5.store2", "a notary-2 presentation is stored on all four", rec2.gcrAllAt !== null && rows2.every(x => json(x) === json(rows2[0])) && rows2[0]?.status === "stored", json(rows2[0]))
})

await step("06-negatives", async () => {
    const before = await quiescentStates()
    const t3 = tok.neg.tokenId

    // The stored attestation again, and a second one made on the same token.
    refusedEverywhere("6.replay", "the same attestation stored again", await submitEverywhere("neg", alice, await storeTx(alice, node(1), tok.main.tokenId, JSON.stringify(pres.main))), /used|stored/i)
    refusedEverywhere("6.reuse", "a second attestation on the same token", await submitEverywhere("neg", alice, await storeTx(alice, node(1), tok.main.tokenId, JSON.stringify(pres.mainSecond))), /used|stored/i)
    const proxyAfter = await openProxy(alice, node(2), tok.main.tokenId, STORE_URL)
    check("6.proxy-used", "no relay session for a used token", proxyAfter?.result !== 200, json(proxyAfter?.response).slice(0, 200))

    // Another account's token: bob's own presentation naming alice's request.
    const local = startLocalRelay("api.github.com", 443)
    try {
        const pb = await openProxy(bob, node(2), t3, STORE_URL)
        check("6.proxy-owner", "no relay session for another account's token", pb?.result !== 200, json(pb?.response).slice(0, 200))
        const bobPres = await attest("bob-on-alice-token", {
            notaryUrl: NOTARIES[0].url,
            proxyUrl: local.url,
            trustedNotaryKeys: TRUSTED_KEYS,
            binding: binding("store", bob.address, t3),
            request: { url: STORE_URL, headers: UA },
        })
        refusedEverywhere("6.owner", "a store naming another account's token", await submitEverywhere("neg", bob, await storeTx(bob, node(1), t3, JSON.stringify(bobPres.presentation))), /another account|owner/i)
    } finally {
        local.stop()
    }

    // A notary the fork does not trust.
    const pu = await openProxy(alice, node(2), t3, STORE_URL)
    const untrusted = await attest("untrusted-notary", {
        notaryUrl: NOTARIES[2].url,
        proxyUrl: relayDialUrl(pu?.response?.websocketProxyUrl),
        trustedNotaryKeys: [NOTARIES[2].publicKey],
        binding: binding("store", alice.address, t3),
        request: { url: STORE_URL, headers: UA },
    })
    refusedEverywhere("6.notary", "a presentation signed by an untrusted notary key", await submitEverywhere("neg", alice, await storeTx(alice, node(1), t3, JSON.stringify(untrusted.presentation))), /notary|key|trust/i)

    // A revealed Authorization value, committed by a prover that skips the SDK's reveal policy.
    const pa = await openProxy(alice, node(3), t3, STORE_URL)
    const revealed = await attest("revealed-authorization", {
        notaryUrl: NOTARIES[0].url,
        proxyUrl: relayDialUrl(pa?.response?.websocketProxyUrl),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("store", alice.address, t3),
        request: { url: STORE_URL, headers: { ...UA, ...FAKE_AUTH } },
        commit: "all",
        rawCommit: true,
    })
    refusedEverywhere("6.auth-store", "a store whose presentation reveals an Authorization value", await submitEverywhere("neg", alice, await storeTx(alice, node(1), t3, JSON.stringify(revealed.presentation))), /authorization/i)

    // Oversize: the SDK refuses before signing; the node must refuse a client that does not.
    // 70 000 padding bytes put any presentation of this run over the 65 536-byte cap.
    const big = JSON.stringify({ version: pres.main.version, data: pres.main.data + "00".repeat(70_000), meta: pres.main.meta })
    let sdkRefused = ""
    try {
        await (await service(alice, node(1))).storeProof(t3, big, { storage: "onchain" })
    } catch (error) {
        sdkRefused = String(error)
    }
    check("6.oversize-sdk", "SDK storeProof refuses an oversize presentation before signing", /over the network limit/.test(sdkRefused), sdkRefused.slice(0, 200))
    refusedEverywhere("6.oversize", "an oversize store", await submitEverywhere("neg", alice, await storeTx(alice, node(1), t3, big)), /larger than/i)

    // A notarized presentation with bytes appended after it.
    const trailing = JSON.stringify({ version: pres.main.version, data: pres.main.data + "00".repeat(16), meta: pres.main.meta })
    refusedEverywhere("6.malformed", "a presentation with trailing bytes", await submitEverywhere("neg", alice, await storeTx(alice, node(1), t3, trailing)), /does not verify|decode/i)

    // Identity links: a revealed Authorization value, and an unauthenticated /user.
    const t4 = tok.idneg.tokenId
    const pia = await openProxy(alice, node(1), t4, ID_URL)
    const idAuth = await attest("identity-revealed-authorization", {
        notaryUrl: NOTARIES[0].url,
        proxyUrl: relayDialUrl(pia?.response?.websocketProxyUrl),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("github", alice.address, t4),
        request: { url: ID_URL, headers: { ...UA, ...FAKE_AUTH } },
        commit: "all",
        rawCommit: true,
    })
    refusedEverywhere("6.auth-identity", "an identity link that reveals an Authorization value", await identityEverywhere(idAuth.presentation), /authorization/i)
    const pin = await openProxy(alice, node(4), t4, ID_URL)
    const idAnon = await attest("identity-unauthenticated", {
        notaryUrl: NOTARIES[1].url,
        proxyUrl: relayDialUrl(pin?.response?.websocketProxyUrl),
        trustedNotaryKeys: TRUSTED_KEYS,
        binding: binding("github", alice.address, t4),
        request: { url: ID_URL, headers: UA },
        commit: "all",
        rawCommit: true,
    })
    const anon = await identityEverywhere(idAnon.presentation)
    refusedEverywhere("6.identity-401", "an identity link over GitHub's 401 (the SDK's absolute request target passes)", anon, /status is 40|response/i)
    check("6.identity-target", "the SDK's absolute-form request target is not what refuses it", anon.every(a => !/links need GET/.test(a.message)), anon[0]?.message.slice(0, 160))

    // Proxy requests that are not the token owner's signed, audience-bound call.
    await proxyAuthNegatives(t3)

    const after = await quiescentStates()
    const moved = before
        .map((b, k) => (json(b.tables) === json(after[k].tables) && b.balancesDigest === after[k].balancesDigest ? null : b.node))
        .filter(Boolean)
    check("6.state", "the refused cases changed no state on any node", moved.length === 0 && stateDifferences(after).length === 0, moved.length ? `changed on ${moved.join(",")}` : `height ${after[0].height}`)
})

/** The SDK's identity link, built on each node's own client (each signs its own copy). */
async function identityEverywhere(presentation: any): Promise<Admission[]> {
    const out: Admission[] = []
    for (const n of NODES) {
        const d = await client(alice, n)
        const t0 = Date.now()
        try {
            const r: any = await new Identities().addWeb2IdentityViaTLSN(d, "github", presentation, "", { recv: [], sent: [] } as any, [], "octocat", "583231")
            const data = r?.response?.data
            if (data?.valid !== true) {
                out.push({ node: n.name, valid: false, message: `confirm: ${String(data?.message ?? json(r)).slice(0, 600)}`, ms: Date.now() - t0 })
            } else {
                const why = broadcastRefusal(await d.broadcast(r))
                out.push({ node: n.name, valid: why === "", message: why, ms: Date.now() - t0 })
            }
        } catch (error) {
            out.push({ node: n.name, valid: false, message: `threw: ${String(error).slice(0, 600)}`, ms: Date.now() - t0 })
        }
        admissionMs.push({ kind: "identity-neg", node: n.name, ms: out[out.length - 1].ms, valid: out[out.length - 1].valid })
    }
    return out
}

async function proxyAuthNegatives(tokenId: string) {
    const d = await client(alice, node(1))
    const data = { tokenId, targetUrl: STORE_URL }
    const body = JSON.stringify({ method: "nodeCall", params: [{ message: "requestTLSNproxy", data }] })
    const identity = "ed25519:" + bare(alice.address)
    const sign = async (bytes: Uint8Array) => (await d.crypto.sign("ed25519", bytes)).signature as Uint8Array
    const genesisHash: string = await (d as any)._genesisHash(node(1).rpc)
    const keys = await Promise.all(NODES.map(async n => bare(await (await fetch(new URL("/publickey", n.rpc))).json())))
    const post = async (n: Node, headers: Record<string, string>) => {
        const res = await fetch(n.rpc, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
        const text = await res.text()
        let parsed: any = text
        try {
            parsed = JSON.parse(text)
        } catch {}
        const ok = res.status === 200 && parsed?.result === 200 && typeof parsed?.response?.websocketProxyUrl === "string"
        return { node: n.name, valid: ok, message: `HTTP ${res.status} ${json(parsed?.response ?? parsed).slice(0, 300)}`, ms: 0 }
    }
    const unsigned: Admission[] = []
    const noAudience: Admission[] = []
    const wrongAudience: Admission[] = []
    for (const n of NODES) {
        unsigned.push(await post(n, {}))
        noAudience.push(await post(n, await bodyBoundAuthHeaders({ genesisHash, identity, body, sign })))
        const other = keys[n.i % NODES.length]
        wrongAudience.push(await post(n, await bodyBoundAuthHeaders({ genesisHash, identity, body, sign, audience: other })))
    }
    const all = (xs: Admission[]) => xs.map(x => `${x.node} ${x.message}`)
    evidence("negative-proxy-auth", { unsigned: all(unsigned), noAudience: all(noAudience), wrongAudience: all(wrongAudience) })
    const refusedAll = (xs: Admission[], re: RegExp) => xs.every(x => !x.valid && re.test(x.message))
    check("6.proxy-unsigned", "an unsigned requestTLSNproxy is refused by all four", refusedAll(unsigned, /AUTH_REQUIRED|401/), unsigned[0].message)
    check("6.proxy-no-audience", "a signed requestTLSNproxy without an audience is refused by all four", refusedAll(noAudience, /audience|401|AUTH/i), noAudience[0].message)
    check("6.proxy-audience", "a requestTLSNproxy signed for another node is refused by all four", refusedAll(wrongAudience, /another node|401/i), wrongAudience[0].message)
}

await step("07-restart", async () => {
    // node-4 comes back with an empty database and must rebuild the TLSN
    // table from its peers' blocks alone.
    const restartAt = Date.now()
    compose(["stop", "node-4"], 120_000)
    psql("postgres", "drop database node4_db with (force)")
    psql("postgres", "create database node4_db")
    psql("postgres", "grant all privileges on database node4_db to demosuser")
    forgetColumns("node4_db")
    compose(["start", "node-4"], 120_000)
    const deadline = Date.now() + 600_000
    let t = await tips()
    while (Date.now() < deadline) {
        t = await tips()
        if (t[3] >= 0 && t[3] >= Math.max(t[0], t[1], t[2]) - 1 && t[3] > (tok.notary2.requestHeight ?? 0) + 5) break
        await sleep(3000)
    }
    const caughtUpMs = Date.now() - restartAt
    const states = await quiescentStates(NODES, 300_000)
    evidence("restart-states", states)
    const diffs = stateDifferences(states)
    const row4 = tlsnRow(node(4), tok.main.tokenId)
    const row1 = tlsnRow(node(1), tok.main.tokenId)
    check("7.resync", "node-4 resynced from an empty database within 10 min", t[3] >= 0, `tips ${t.join("/")}, ${Math.round(caughtUpMs / 1000)} s`)
    check("7.agree", "after resync all four agree on every table, gcr_tlsnotary included", diffs.length === 0 && json(row4) === json(row1) && row4?.status === "stored", diffs.join("; ") || `gcr_tlsnotary ${states[0].tables.gcr_tlsnotary}`)
})

await step("06-expiry", async () => {
    const te = tok.expiry
    const target = (te.expiresAtHeight ?? 0) + 1
    say(`waiting for block ${target} (token expires after ${te.expiresAtHeight}); tips ${(await tips()).join("/")}`)
    const t = await waitHeight(target, NODES, 90 * 60_000)
    if (!t.every(x => x >= target)) {
        check("6.expired", "a store naming an expired token", false, `chain did not reach ${target}: tips ${t.join("/")}`)
        return
    }
    const answers = await submitEverywhere("neg", alice, await storeTx(alice, node(2), te.tokenId, JSON.stringify(pres.expiry)))
    refusedEverywhere("6.expired", "a store naming an expired token", answers, /expired/i)
    const p = await openProxy(alice, node(2), te.tokenId, STORE_URL)
    check("6.proxy-expired", "no relay session for an expired token", p?.result !== 200, json(p?.response).slice(0, 200))
    const views = await Promise.all(NODES.map(n => nodeCall(n, "tlsnotary.getToken", { tokenId: te.tokenId })))
    check("6.read-expired", "every node serves the token as expired", views.every(v => v.response?.token?.status === "expired"), views.map(v => v.response?.token?.status).join("/"))
})

await step("08-rollback", async () => {
    skip(
        "8.rollback",
        "unlink, roll back and check consistency",
        "the rollback of TLSN links is merged (node#1245) and unit-tested there, but undoing a link needs one: every TLSN link endpoint (GitHub /user, Discord /users/@me) answers 200 only with an OAuth token, and the run uses no credentials (see step 4)",
    )
})

await step("09-final", async () => {
    const states = await quiescentStates()
    evidence("final-states", states)
    const diffs = stateDifferences(states)
    check("final.agree", "all four validators agree on every table at the end", diffs.length === 0, diffs.join("; ") || `height ${states[0].height}, gcr_tlsnotary ${states[0].tables.gcr_tlsnotary}`)
})

await prover.close()

// ---- report -----------------------------------------------------------------------

const tipNow = Math.max(...(await tips()))
const blocks: { n: number; t: number; txs: number }[] = []
for (let h = 1; h <= tipNow; h++) {
    const b = await blockAt(node(1), h)
    const t = blockTimeMs(b)
    if (t !== null) blocks.push({ n: h, t, txs: Array.isArray(b?.content?.ordered_transactions) ? b.content.ordered_transactions.length : 0 })
}
const intervals = blocks.slice(1).map((b, k) => (b.t - blocks[k].t) / 1000)
const active = blocks.filter(b => b.t >= runStart)
const activeSpanS = active.length > 1 ? (active[active.length - 1].t - active[0].t) / 1000 : 0
const activeTxs = active.reduce((a, b) => a + b.txs, 0)
const metrics = {
    blocks: blocks.length,
    blockTimeS: quantiles(intervals),
    tpsMain: { txs: activeTxs, spanS: activeSpanS, tps: activeSpanS > 0 ? +(activeTxs / activeSpanS).toFixed(3) : 0, peakBlockTxs: Math.max(0, ...active.map(b => b.txs)) },
    timeToIncludedAllMs: quantiles(tlsnTxs.filter(x => x.includedAllAt).map(x => x.includedAllAt! - x.submittedAt)),
    timeToGcrAllMs: quantiles(tlsnTxs.filter(x => x.gcrAllAt).map(x => x.gcrAllAt! - x.submittedAt)),
    perTx: tlsnTxs.map(x => ({ kind: x.kind, block: x.block, includedAllMs: x.includedAllAt ? x.includedAllAt - x.submittedAt : null, gcrAllMs: x.gcrAllAt ? x.gcrAllAt - x.submittedAt : null })),
    admissionMs: {
        tlsnStore: quantiles(admissionMs.filter(a => a.kind === "tlsn_store").map(a => a.ms)),
        tlsnStoreBroadcast: quantiles(admissionMs.filter(a => a.kind === "tlsn_store-broadcast").map(a => a.ms)),
        refusedStore: quantiles(admissionMs.filter(a => a.kind === "neg").map(a => a.ms)),
        refusedIdentity: quantiles(admissionMs.filter(a => a.kind === "identity-neg").map(a => a.ms)),
    },
    verifyMsLocal: quantiles(verifyMs.map(v => v.ms)),
    attestMs: attestMs.map(a => ({ ...a, ms: Math.round(a.ms) })),
}
evidence("metrics", metrics)

const stepNames = [...new Set(checks.map(c => c.step))]
const stepVerdict = (s: string) => {
    const cs = checks.filter(c => c.step === s)
    if (cs.some(c => c.verdict === "FAIL")) return "FAIL"
    if (cs.every(c => c.verdict === "SKIP")) return "SKIP"
    return "PASS"
}
const failed = checks.filter(c => c.verdict === "FAIL")
const q = (o: any) => (o?.n ? `p50 ${o.p50}, p95 ${o.p95}, max ${o.max} (n=${o.n})` : "n/a")
const md = [
    `# TLSN e2e ${RUN_DIR.split("/").pop()}`,
    "",
    `Result: **${failed.length === 0 ? "PASS" : "FAIL"}** (${checks.filter(c => c.verdict === "PASS").length} pass, ${failed.length} fail, ${checks.filter(c => c.verdict === "SKIP").length} skip)`,
    "",
    `Notaries: ${NOTARIES.map(n => `notary-${n.k} ${n.publicKey}${n.trusted ? "" : " (untrusted)"}`).join("; ")}`,
    `TLS target: api.github.com (real public endpoint, production root store); no credentials${GH_TOKEN ? " except the GitHub token for step 4" : ""}.`,
    "",
    "## Steps",
    "",
    "| step | verdict |",
    "|---|---|",
    ...stepNames.map(s => `| ${s} | ${stepVerdict(s)} |`),
    "",
    "## Checks",
    "",
    "| id | verdict | check | detail |",
    "|---|---|---|---|",
    ...checks.map(c => `| ${c.id} | ${c.verdict} | ${c.title} | ${c.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 300)} |`),
    "",
    "## Metrics",
    "",
    `- Block time (s, all ${metrics.blocks} blocks): ${q(metrics.blockTimeS)}`,
    `- TPS main (run window): ${metrics.tpsMain.tps} (${metrics.tpsMain.txs} txs over ${metrics.tpsMain.spanS.toFixed(0)} s, peak ${metrics.tpsMain.peakBlockTxs} txs/block); a functional run, not a load test`,
    "- TPS L2PS: not exercised",
    `- Time to included on all four, TLSN txs (ms): ${q(metrics.timeToIncludedAllMs)}`,
    `- Time to GCR on all four, TLSN txs (ms): ${q(metrics.timeToGcrAllMs)}`,
    `- Admission, tlsn_store accepted: confirm (signature and fee) ${q(metrics.admissionMs.tlsnStore)} ms; broadcast (presentation verify + simulation against the token row) ${q(metrics.admissionMs.tlsnStoreBroadcast)} ms`,
    `- Admission, refused (confirm + broadcast round trip per node): stores ${q(metrics.admissionMs.refusedStore)} ms; identity links ${q(metrics.admissionMs.refusedIdentity)} ms`,
    `- Presentation verify, the pinned wasm verifier admission and block apply both run (ms, per presentation, on this host): ${q(metrics.verifyMsLocal)}`,
    `- SDK attest (browser prover, real GitHub round trip): ${metrics.attestMs.map(a => `${a.name} ${a.ms}`).join(", ")}`,
    "",
]
writeFileSync(join(RUN_DIR, "report.md"), md.join("\n"))
writeFileSync(join(RUN_DIR, "report.json"), json({ checks, metrics, tokens: tok }) + "\n")
say(`report: ${join(RUN_DIR, "report.md")}`)
say(`${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}`)
process.exit(failed.length === 0 ? 0 : 1)
