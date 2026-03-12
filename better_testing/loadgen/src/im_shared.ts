import { deserializeUint8Array, serializeUint8Array } from "@kynesyslabs/demosdk/utils"
import { ucrypto } from "@kynesyslabs/demosdk/encryption"
import { envBool, envInt, logNonCriticalError, logNonCriticalErrorOnce, normalizeWsUrl, nowMs, sleep, splitCsv } from "./framework/common"
import { percentile, ReservoirSampler } from "./framework/metrics"

export { normalizeWsUrl, nowMs } from "./framework/common"
export { percentile, ReservoirSampler } from "./framework/metrics"

export function getImTargets(): string[] {
  const explicit = splitCsv(process.env.IM_TARGETS)
  if (explicit.length > 0) return explicit.map(normalizeWsUrl)

  const fromRpc = splitCsv(process.env.TARGETS)
  if (fromRpc.length > 0) {
    return fromRpc.map(u => {
      const normalized = u.trim().replace(/\/+$/, "")
      const parsed = new URL(normalized)
      const host = parsed.hostname
      const rpcPort = Number.parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10)

      // Local devnet convention:
      // 53551 -> 3005, 53552 -> 3006, 53553 -> 3007, 53554 -> 3008
      if ((host === "localhost" || host === "127.0.0.1") && rpcPort >= 53551 && rpcPort <= 53554) {
        const signalingPort = 3005 + (rpcPort - 53551)
        return `ws://${host}:${signalingPort}`
      }

      return `ws://${host}:3005`
    })
  }

  return [
    "ws://localhost:3005",
    "ws://localhost:3006",
    "ws://localhost:3007",
    "ws://localhost:3008",
  ]
}

export type RegisterClientParams = {
  wsUrl: string
  clientId: string
  instanceId: string
  timeoutSec?: number
}

export type RegisteredClient = {
  wsUrl: string
  clientId: string
  ws: WebSocket
  close: () => void
  sendRaw: (data: any) => void
}

export type ImPerfPayload = {
  kind: "im_perf"
  role: "ping" | "pong"
  id: string
  sentAtMs: number
  sizeBytes: number
  pad?: string
}

export function encodePerfPayload(payload: ImPerfPayload): { algorithm: "rsa"; serializedEncryptedData: string } {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  return { algorithm: "rsa", serializedEncryptedData: serializeUint8Array(bytes) }
}

export function decodePerfPayload(message: any): ImPerfPayload | null {
  const raw = message?.serializedEncryptedData
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const bytes = deserializeUint8Array(raw)
    const text = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(text)
    if (parsed?.kind !== "im_perf") return null
    if (parsed?.role !== "ping" && parsed?.role !== "pong") return null
    if (typeof parsed?.id !== "string") return null
    if (typeof parsed?.sentAtMs !== "number") return null
    if (typeof parsed?.sizeBytes !== "number") return null
    return parsed as ImPerfPayload
  } catch (error) {
    logNonCriticalErrorOnce("im.decodePerfPayload", "im_shared.decodePerfPayload", error)
    return null
  }
}

function randomHex(bytes: number): string {
  const u8 = new Uint8Array(bytes)
  crypto.getRandomValues(u8)
  return Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join("")
}

export function generateClientId(): string {
  // 32 bytes -> 64 hex chars
  return "0x" + randomHex(32)
}

async function buildRegistrationProof(instanceId: string): Promise<{
  publicKeyBytes: Uint8Array
  verification: { algorithm: "ed25519"; serializedSignedData: string; serializedPublicKey: string; serializedMessage: string }
}> {
  const uc = ucrypto.getInstance(instanceId)
  await uc.generateIdentity("ed25519")
  const message = new TextEncoder().encode("im_perf_register:" + randomHex(16))
  const signed = await uc.sign("ed25519", message)
  const publicKeyBytes = new Uint8Array(signed.publicKey as any)
  const signatureBytes = new Uint8Array(signed.signature as any)

  return {
    publicKeyBytes,
    verification: {
      algorithm: "ed25519",
      serializedSignedData: serializeUint8Array(signatureBytes),
      serializedPublicKey: serializeUint8Array(publicKeyBytes),
      serializedMessage: serializeUint8Array(message),
    },
  }
}

export async function registerClient(params: RegisterClientParams): Promise<RegisteredClient> {
  const timeoutSec = Math.max(1, Math.floor(params.timeoutSec ?? envInt("IM_REGISTER_TIMEOUT_SEC", 30)))
  const wsUrl = normalizeWsUrl(params.wsUrl)

  const { publicKeyBytes, verification } = await buildRegistrationProof(params.instanceId)

  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"

  let openResolve: (() => void) | null = null
  let openReject: ((err: any) => void) | null = null
  const openPromise = new Promise<void>((resolve, reject) => {
    openResolve = resolve
    openReject = reject
  })

  let registerResolve: (() => void) | null = null
  let registerReject: ((err: any) => void) | null = null
  const registerPromise = new Promise<void>((resolve, reject) => {
    registerResolve = resolve
    registerReject = reject
  })

  ws.onopen = () => openResolve?.()
  ws.onerror = (e: any) => {
    openReject?.(e)
    registerReject?.(e)
  }
  ws.onmessage = (evt: MessageEvent) => {
    try {
      const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as any)
      const msg = JSON.parse(raw)
      if (msg?.type === "register" && msg?.payload?.success === true && msg?.payload?.clientId === params.clientId) {
        registerResolve?.()
      }
      if (msg?.type === "error") {
        // If registration fails, surface early.
        const details = msg?.payload?.details ?? JSON.stringify(msg?.payload ?? msg)
        registerReject?.(new Error(`IM error: ${details}`))
      }
    } catch (error) {
      logNonCriticalError("im_shared.registerClient.onmessage", error, {
        clientId: params.clientId,
        wsUrl,
      })
    }
  }

  await Promise.race([
    openPromise,
    sleep(timeoutSec * 1000).then(() => {
      throw new Error(`WebSocket open timeout after ${timeoutSec}s: ${wsUrl}`)
    }),
  ])

  // Send register
  ws.send(JSON.stringify({
    type: "register",
    payload: {
      clientId: params.clientId,
      publicKey: Array.from(publicKeyBytes),
      verification,
    },
  }))

  await Promise.race([
    registerPromise,
    sleep(timeoutSec * 1000).then(() => {
      throw new Error(`Register timeout after ${timeoutSec}s for ${params.clientId} at ${wsUrl}`)
    }),
  ])

  return {
    wsUrl,
    clientId: params.clientId,
    ws,
    close: () => {
      try { ws.close() } catch (error) {
        logNonCriticalError("im_shared.close", error, { clientId: params.clientId, wsUrl })
      }
    },
    sendRaw: (data: any) => ws.send(typeof data === "string" ? data : JSON.stringify(data)),
  }
}

export function maybeSilenceConsole() {
  if (!envBool("QUIET", true)) return
  const allowedPrefixes = ["{", "["]
  const originalLog = console.log.bind(console)
  const originalWarn = console.warn.bind(console)
  const filter = (...args: any[]) => {
    if (args.length === 0) return
    const first = args[0]
    if (typeof first === "string") {
      const trimmed = first.trim()
      for (const p of allowedPrefixes) {
        if (trimmed.startsWith(p)) return originalLog(...args)
      }
      return
    }
    return originalLog(...args)
  }
  console.log = filter as any
  console.warn = (...args: any[]) => originalWarn(...args)
}
