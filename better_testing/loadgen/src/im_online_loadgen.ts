import { appendJsonl, getRunConfig, writeJson } from "./framework/io"
import { logNonCriticalError } from "./framework/common"
import {
  ReservoirSampler,
  decodePerfPayload,
  encodePerfPayload,
  generateClientId,
  getImTargets,
  maybeSilenceConsole,
  nowMs,
  percentile,
  registerClient,
} from "./im_shared"

type Config = {
  wsTargets: string[]
  durationSec: number
  pairs: number
  inflightPerSender: number
  sampleLimit: number
  messageBytes: number
  emitTimeseries: boolean
  rateLimitRps: number
}

type Counters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  error: number
  timeout: number
}

type TimeseriesPoint = {
  tSec: number
  ok: number
  total: number
  error: number
  timeout: number
  tpsOk: number
  latencyMs: { sampleCount: number; p50: number; p95: number; p99: number }
  timestamp: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true
    case "0":
    case "false":
    case "no":
    case "n":
    case "off":
      return false
    default:
      return fallback
  }
}

function pickTarget(targets: string[], idx: number): string {
  if (targets.length === 0) throw new Error("No IM_TARGETS configured")
  return targets[Math.abs(idx) % targets.length]!
}

function busyWaitJitter(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs)
  const extra = span > 0 ? Math.floor(Math.random() * (span + 1)) : 0
  return sleep(Math.max(0, minMs + extra))
}

function getConfig(): Config {
  const wsTargets = getImTargets()
  return {
    wsTargets,
    durationSec: envInt("DURATION_SEC", 20),
    pairs: Math.max(1, envInt("IM_PAIRS", 2)),
    inflightPerSender: Math.max(1, envInt("INFLIGHT_PER_SENDER", envInt("INFLIGHT_PER_WALLET", 1))),
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    messageBytes: Math.max(0, envInt("IM_MESSAGE_BYTES", 128)),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
    rateLimitRps: Math.max(0, envInt("RATE_LIMIT_RPS", 0)),
  }
}

function randomId(): string {
  return crypto.randomUUID?.() ?? `${nowMs()}-${Math.floor(Math.random() * 1e9)}`
}

function buildPayload(role: "ping" | "pong", id: string, sentAtMs: number, sizeBytes: number) {
  const pad = sizeBytes > 0 ? "0".repeat(sizeBytes) : undefined
  return encodePerfPayload({ kind: "im_perf", role, id, sentAtMs, sizeBytes, pad })
}

export async function runImOnlineLoadgen() {
  maybeSilenceConsole()
  const cfg = getConfig()
  const logEvents = envBool("IM_LOG_EVENTS", false)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/im_online`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
    timeseriesPath: `${artifactBase}.timeseries.jsonl`,
    logPath: `${artifactBase}.log.jsonl`,
  }

  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + cfg.durationSec * 1000

  const counters: Counters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    error: 0,
    timeout: 0,
  }

  const sampler = new ReservoirSampler(cfg.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)

  let lastPointAtMs = startedAtMs
  let lastOk = 0
  let lastTotal = 0
  let lastError = 0
  let lastTimeout = 0

  async function timeseriesLoop() {
    if (!cfg.emitTimeseries) return
    while (nowMs() < stopAtMs) {
      await sleep(1000)
      const now = nowMs()
      const elapsedSinceLast = Math.max(0.001, (now - lastPointAtMs) / 1000)
      lastPointAtMs = now

      const okDelta = counters.ok - lastOk
      const totalDelta = counters.total - lastTotal
      const errorDelta = counters.error - lastError
      const timeoutDelta = counters.timeout - lastTimeout

      lastOk = counters.ok
      lastTotal = counters.total
      lastError = counters.error
      lastTimeout = counters.timeout

      const samples = timeseriesSampler.snapshotSorted()
      const point: TimeseriesPoint = {
        tSec: (now - startedAtMs) / 1000,
        ok: okDelta,
        total: totalDelta,
        error: errorDelta,
        timeout: timeoutDelta,
        tpsOk: okDelta / elapsedSinceLast,
        latencyMs: {
          sampleCount: timeseriesSampler.size(),
          p50: percentile(samples, 50),
          p95: percentile(samples, 95),
          p99: percentile(samples, 99),
        },
        timestamp: new Date().toISOString(),
      }

      appendJsonl(artifacts.timeseriesPath, point)
    }
  }

  const pairs: Array<{
    senderId: string
    receiverId: string
    sender: Awaited<ReturnType<typeof registerClient>>
    receiver: Awaited<ReturnType<typeof registerClient>>
  }> = []

  function logEvent(event: any) {
    if (!logEvents) return
    appendJsonl(artifacts.logPath, { t: new Date().toISOString(), ...event })
  }

  // Register clients (2 per pair). Stagger slightly to avoid thundering herd.
  for (let i = 0; i < cfg.pairs; i++) {
    const wsUrl = pickTarget(cfg.wsTargets, i)
    const senderId = generateClientId()
    const receiverId = generateClientId()
    const sender = await registerClient({ wsUrl, clientId: senderId, instanceId: `im:${senderId}` })
    await busyWaitJitter(10, 50)
    const receiver = await registerClient({ wsUrl, clientId: receiverId, instanceId: `im:${receiverId}` })
    await busyWaitJitter(10, 50)
    pairs.push({ senderId, receiverId, sender, receiver })
  }

  appendJsonl(artifacts.logPath, {
    t: new Date().toISOString(),
    phase: "registered",
    wsTargets: cfg.wsTargets,
    pairs: pairs.map(p => ({ wsUrl: p.sender.wsUrl, senderId: p.senderId, receiverId: p.receiverId })),
  })

  // Receiver behavior: echo pings back as pongs
  for (const pair of pairs) {
    pair.receiver.ws.onmessage = (evt: MessageEvent) => {
      try {
        const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as any)
        const msg = JSON.parse(raw)
        if (msg?.type === "error") {
          logEvent({ phase: "receiverError", receiverId: pair.receiverId, msg })
          return
        }
        if (msg?.type !== "message") return
        const fromId = msg?.payload?.fromId
        const payload = decodePerfPayload(msg?.payload?.message)
        if (!fromId || !payload) return
        if (payload.role !== "ping") return

        logEvent({ phase: "recvPing", receiverId: pair.receiverId, fromId, id: payload.id })

        // Build pong with same id and sentAtMs (sender will measure RTT).
        const pong = buildPayload("pong", payload.id, payload.sentAtMs, payload.sizeBytes)
        pair.receiver.sendRaw({ type: "message", payload: { targetId: fromId, message: pong } })
      } catch (error) {
        logNonCriticalError("im_online.receiver.onmessage", error, {
          receiverId: pair.receiverId,
          senderId: pair.senderId,
        })
      }
    }
  }

  // Sender behavior: measure pong RTT
  const pending = new Map<string, number>()
  for (const pair of pairs) {
    pair.sender.ws.onmessage = (evt: MessageEvent) => {
      try {
        const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as any)
        const msg = JSON.parse(raw)
        if (msg?.type === "error") {
          logEvent({ phase: "senderError", senderId: pair.senderId, msg })
          counters.error++
          return
        }
        if (msg?.type !== "message") return
        const payload = decodePerfPayload(msg?.payload?.message)
        if (!payload) return
        if (payload.role !== "pong") return
        const started = pending.get(payload.id)
        if (started === undefined) return
        pending.delete(payload.id)

        const elapsed = performance.now() - started
        sampler.add(elapsed)
        timeseriesSampler.add(elapsed)
        counters.ok++
        logEvent({ phase: "recvPong", senderId: pair.senderId, id: payload.id, rttMs: elapsed })
      } catch (error) {
        logNonCriticalError("im_online.sender.onmessage", error, {
          senderId: pair.senderId,
          receiverId: pair.receiverId,
        })
      }
    }
  }

  const rateLimitRps = cfg.rateLimitRps
  const perSenderIntervalMs = rateLimitRps > 0 ? Math.max(1, Math.floor(1000 / rateLimitRps)) : 0
  const perSenderLastSendAt: number[] = pairs.map(() => 0)

  async function sendLoop(pairIndex: number) {
    const pair = pairs[pairIndex]!
    const inflight = cfg.inflightPerSender
    const active = new Set<Promise<void>>()

    async function sendOne() {
      counters.total++
      const id = randomId()
      const started = performance.now()
      pending.set(id, started)

      try {
        const sentAtMs = nowMs()
        const ping = buildPayload("ping", id, sentAtMs, cfg.messageBytes)
        pair.sender.sendRaw({ type: "message", payload: { targetId: pair.receiverId, message: ping } })
        logEvent({ phase: "sendPing", senderId: pair.senderId, receiverId: pair.receiverId, id })
      } catch (error) {
        pending.delete(id)
        counters.error++
        logNonCriticalError("im_online.sendPing", error, {
          senderId: pair.senderId,
          receiverId: pair.receiverId,
          id,
        })
        return
      }

      // Timeout handling: if no pong returns, count as timeout and drop.
      const timeoutMs = Math.max(250, envInt("IM_PONG_TIMEOUT_MS", 5000))
      await Promise.race([
        sleep(timeoutMs).then(() => "timeout"),
        (async () => {
          // Poll pending map (cheap) for completion.
          const deadline = performance.now() + timeoutMs
          while (performance.now() < deadline) {
            if (!pending.has(id)) return "ok"
            await sleep(10)
          }
          return "timeout"
        })(),
      ]).then(result => {
        if (result === "timeout" && pending.has(id)) {
          pending.delete(id)
          counters.timeout++
        }
      })
    }

    function launchOne() {
      const p = (async () => {
        if (perSenderIntervalMs > 0) {
          const now = nowMs()
          const last = perSenderLastSendAt[pairIndex] ?? 0
          const waitMs = Math.max(0, last + perSenderIntervalMs - now)
          if (waitMs > 0) await sleep(waitMs)
          perSenderLastSendAt[pairIndex] = nowMs()
        }
        await sendOne()
      })().finally(() => active.delete(p))
      active.add(p)
    }

    while (nowMs() < stopAtMs) {
      while (active.size < inflight && nowMs() < stopAtMs) {
        launchOne()
      }
      if (active.size === 0) break
      await Promise.race(Array.from(active))
    }

    await Promise.allSettled(Array.from(active))
  }

  await Promise.all([timeseriesLoop(), ...pairs.map((_, idx) => sendLoop(idx))])

  counters.endedAtMs = nowMs()

  // Clean shutdown
  for (const pair of pairs) {
    try { pair.sender.close() } catch (error) {
      logNonCriticalError("im_online.cleanup.sender", error, { senderId: pair.senderId })
    }
    try { pair.receiver.close() } catch (error) {
      logNonCriticalError("im_online.cleanup.receiver", error, { receiverId: pair.receiverId })
    }
  }

  const durationSec = (counters.endedAtMs - counters.startedAtMs) / 1000
  const samples = sampler.snapshotSorted()

  const summary = {
    scenario: "im_online",
    ok: counters.ok,
    total: counters.total,
    error: counters.error,
    timeout: counters.timeout,
    durationSec,
    okTps: counters.ok / Math.max(0.001, durationSec),
    latencyMs: {
      sampleCount: sampler.size(),
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
    },
    config: {
      wsTargets: cfg.wsTargets,
      pairs: cfg.pairs,
      inflightPerSender: cfg.inflightPerSender,
      messageBytes: cfg.messageBytes,
      rateLimitRps: cfg.rateLimitRps,
    },
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ im_online_summary: summary }, null, 2))
}
