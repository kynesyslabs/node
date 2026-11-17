/**
 * The SDK's TLSNotary prover, run where it is made to run: tlsn-js needs Web
 * Workers, SharedArrayBuffer and wasm threads, which Bun does not provide, so
 * the SDK's own TLSNotary class is bundled for the browser and driven in
 * headless Chromium. Nothing here builds a presentation; the SDK does.
 *
 * tlsn-js locates its spawner script and wasm relative to the worker's URL,
 * so the tlsn-js build is served at the root next to the bundled worker.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface AttestInput {
    notaryUrl: string
    proxyUrl: string
    trustedNotaryKeys: string[]
    binding?: { purpose: string; sender: string; requestTxHash: string }
    request: { url: string; method?: string; headers?: Record<string, string>; body?: string }
    /** Reveal ranges to commit instead of the SDK's computed ones; "all" reveals both transcripts whole. */
    commit?: { sent: { start: number; end: number }[]; recv: { start: number; end: number }[] } | "all"
    /** Bypass the SDK's reveal policy and use `commit` as is (negative cases only). */
    rawCommit?: boolean
}

export interface AttestOutput {
    ok: boolean
    error?: string
    presentation?: any
    verification?: any
    ms: number
    statuses: string[]
}

const ENTRY = (sdkBuild: string, bufferPkg: string) => `
import { Buffer } from "${bufferPkg}"
import { TLSNotary } from "${sdkBuild}/tlsnotary/TLSNotary.js"
// TLSNotary.verify (sdks main, src/tlsnotary/TLSNotary.ts) reads a global
// Buffer that its webpack helper never provides; apps that attest set one,
// and the "noshim" page leaves it out to show the gap.
if (!location.search.includes("noshim")) globalThis.Buffer = Buffer
window.tlsnVerify = async (presentation, trustedNotaryKeys) => {
  const tlsn = new TLSNotary({ notaryUrl: "http://127.0.0.1:1", trustedNotaryKeys })
  try {
    await tlsn.initialize()
    return { ok: true, verification: await tlsn.verify(presentation) }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  } finally {
    tlsn.destroy()
  }
}
window.tlsnAttest = async input => {
  const statuses = []
  const t0 = performance.now()
  const tlsn = new TLSNotary({
    notaryUrl: input.notaryUrl,
    websocketProxyUrl: input.proxyUrl,
    trustedNotaryKeys: input.trustedNotaryKeys,
    binding: input.binding,
  })
  try {
    await tlsn.initialize()
    // rawCommit: a prover that skips the SDK's reveal checks, as a hostile
    // client would, so the node and not the SDK must refuse what it reveals.
    const res = input.rawCommit
      ? await rawAttest(tlsn, input, s => statuses.push(s))
      : await tlsn.attest(input.request, input.commit, s => statuses.push(s))
    return { ok: true, presentation: res.presentation, verification: res.verification, ms: performance.now() - t0, statuses }
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), ms: performance.now() - t0, statuses }
  } finally {
    tlsn.destroy()
  }
}

// TLSNotary.attest with the commit taken verbatim; everything else is the
// SDK's own code path (worker, notary session, proxy, bind header).
async function rawAttest(tlsn, input, status) {
  const wasm = tlsn.wasm
  const url = new URL(input.request.url)
  const { NotaryServer } = await import("${sdkBuild}/tlsnotary/tlsn-runtime.js")
  const notary = NotaryServer.from(input.notaryUrl)
  const prover = await new wasm.Prover({ serverDns: url.hostname, maxSentData: 16384, maxRecvData: 16384 })
  let presentation = null
  try {
    status("setup")
    await prover.setup(await notary.sessionUrl())
    await prover.sendRequest(input.proxyUrl, {
      url: input.request.url,
      method: input.request.method || "GET",
      headers: tlsn.requestHeaders(input.request),
      body: input.request.body,
    })
    const { sent, recv } = await prover.transcript()
    const commit = input.commit === "all"
      ? { sent: [{ start: 0, end: sent.length }], recv: [{ start: 0, end: recv.length }] }
      : input.commit
    status("notarize")
    const out = await prover.notarize(commit)
    presentation = await new wasm.Presentation({
      attestationHex: out.attestation,
      secretsHex: out.secrets,
      notaryUrl: out.notaryUrl,
      websocketProxyUrl: out.websocketProxyUrl,
      reveal: { ...commit, server_identity: true },
    })
    return { presentation: await presentation.json(), verification: null }
  } finally {
    if (presentation) await presentation.free()
    await prover.free()
  }
}
`

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>tlsn-e2e prover</title></head>
<body><script type="module" src="/main.js"></script></body></html>`

const COI = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
}

/**
 * The installed browser build, when the playwright package pins another
 * revision than the one on disk (CHROMIUM_PATH overrides); undefined lets
 * playwright pick its own.
 */
function chromiumPath(): string | undefined {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
    const root = join(process.env.HOME ?? "", ".cache", "ms-playwright")
    if (!existsSync(root)) return undefined
    const shells = readdirSync(root)
        .filter(d => /^chromium_headless_shell-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    for (const d of shells) {
        const bin = join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        if (existsSync(bin)) return bin
    }
    return undefined
}

async function bundle(entry: string, sdkTree: string, name: string): Promise<string> {
    const r = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", root: sdkTree })
    if (!r.success || r.outputs.length === 0) {
        throw new Error(`${name} bundle failed: ${r.logs.map(String).join("\n")}`)
    }
    return await r.outputs[0].text()
}

/**
 * Starts Chromium with the SDK prover page. `close()` stops the browser and
 * the page server.
 */
export async function startProver(sdkTree: string, workDir: string, log: (s: string) => void) {
    const sdkBuild = join(sdkTree, "build")
    const tlsnJs = join(sdkTree, "node_modules", "tlsn-js", "build")
    if (!existsSync(join(sdkBuild, "tlsnotary", "TLSNotary.js"))) throw new Error(`no SDK build at ${sdkBuild}`)
    const entryFile = join(workDir, "prover-entry.js")
    await Bun.write(entryFile, ENTRY(sdkBuild, join(sdkTree, "node_modules", "buffer", "index.js")))
    const main = await bundle(entryFile, sdkTree, "page")
    const worker = await bundle(join(sdkBuild, "tlsnotary", "worker.js"), sdkTree, "worker")

    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            const path = new URL(req.url).pathname
            if (path === "/") return new Response(HTML, { headers: { "content-type": "text/html", ...COI } })
            if (path === "/main.js") return new Response(main, { headers: { "content-type": "text/javascript", ...COI } })
            if (path === "/worker.js") return new Response(worker, { headers: { "content-type": "text/javascript", ...COI } })
            const rel = path.slice(1)
            if (/^[A-Za-z0-9_.-]+\.(js|wasm)$/.test(rel) || /^snippets\/[A-Za-z0-9_./-]+\.js$/.test(rel)) {
                const f = join(tlsnJs, rel)
                if (!rel.includes("..") && existsSync(f)) {
                    const type = rel.endsWith(".wasm") ? "application/wasm" : "text/javascript"
                    return new Response(readFileSync(f), { headers: { "content-type": type, ...COI } })
                }
            }
            return new Response("not found", { status: 404 })
        },
    })

    const { chromium } = await import("playwright")
    const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() })
    const open = async (query: string) => {
        const page = await (await browser.newContext()).newPage()
        page.on("console", m => log(`[browser:${m.type()}] ${m.text()}`))
        page.on("pageerror", e => log(`[browser:pageerror] ${e.message}`))
        await page.goto(`http://127.0.0.1:${server.port}/${query}`)
        await page.waitForFunction(() => typeof (window as any).tlsnAttest === "function", undefined, { timeout: 30_000 })
        return page
    }
    let page = await open("")

    return {
        async attest(input: AttestInput, timeoutMs = 180_000): Promise<AttestOutput> {
            const run = page.evaluate(i => (window as any).tlsnAttest(i), input) as Promise<AttestOutput>
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<"timeout">(r => {
                timer = setTimeout(() => r("timeout"), timeoutMs)
            })
            try {
                const out = await Promise.race([run, timeout])
                if (out !== "timeout") return out
            } finally {
                clearTimeout(timer)
            }
            // A stalled session keeps its MPC work and sockets alive in the
            // page; closing it keeps them out of the next attestation.
            run.catch(() => {})
            await page.context().close().catch(() => {})
            page = await open("")
            return { ok: false, error: `attest timed out after ${timeoutMs} ms`, ms: timeoutMs, statuses: [] }
        },
        /** The SDK's offline verify, in a page with or without a global Buffer. */
        async verify(presentation: any, trustedNotaryKeys: string[], withBuffer: boolean) {
            const p = withBuffer ? page : await open("?noshim")
            try {
                return (await p.evaluate(
                    ([pr, k]) => (window as any).tlsnVerify(pr, k),
                    [presentation, trustedNotaryKeys] as const,
                )) as { ok: boolean; error?: string; verification?: any }
            } finally {
                if (p !== page) await p.context().close()
            }
        },
        async close() {
            await browser.close().catch(() => {})
            server.stop(true)
        },
    }
}
