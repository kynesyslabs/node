import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { appendJsonl, getRunConfig, writeJson } from "../../framework/io"
import { ReservoirSampler, summarizeLatency } from "../../framework/metrics"
import { envBool, envFloat, envInt, logNonCriticalError, logNonCriticalErrorOnce, normalizeHexAddress, normalizeRpcUrl, nowMs, sleep } from "../../framework/common"
import { BroadcastError, ConfirmError, ConvergenceError, RpcTimeoutError, SetupError, loadgenErrorFromMessage, normalizeLoadgenError } from "../../framework/errors"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import {
  getTokenTargets,
  maybeSilenceConsole,
  readWalletMnemonics,
  waitForRpcReady,
  waitForTxReady,
} from "../../token_shared"

type LoadgenConfig = {
  rpcUrls: string[]
  wallets: string[]
  durationSec: number
  concurrency: number
  algorithm: string
  sampleLimit: number
  emitTimeseries: boolean
  maxErrorRate: number
  minLoopDelayMs: number
  stopOnRateLimit: boolean
  settleTimeoutSec: number
  settlePollMs: number
  opTimeoutMs: number
}

type WalletIdentityProbe = {
  mnemonicIndex: number
  ownerAddress: string
}

type LoadgenCounters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  confirmError: number
  broadcastError: number
  validationError: number
  networkError: number
  rateLimited: number
  cleanupError: number
}

type ErrorSample = {
  at: string
  stage: "confirm" | "broadcast" | "cleanup"
  message: string
  code?: string
  retryable?: boolean
  context?: Record<string, unknown> | null
}

type WorkerReport = {
  workerId: number
  rpcUrl: string
  ownerAddress: string
  iterations: number
  generated: number
  outstanding: string[]
  fatalError?: string
}

type TimeseriesPoint = {
  tSec: number
  ok: number
  total: number
  confirmError: number
  broadcastError: number
  validationError: number
  networkError: number
  rateLimited: number
  tps: number
  okTps: number
  latencyMs: ReturnType<typeof summarizeLatency>
  timestamp: string
}

function stringifyForError(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractTransportErrorMessage(label: string, operation: "add" | "remove", response: any): string {
  const raw =
    response?.error ??
    response?.response?.error ??
    response?.response?.message ??
    response?.message ??
    stringifyForError(response)
  return `${label} (${operation}): ${typeof raw === "string" ? raw : stringifyForError(raw)}`
}

function getConfig(wallets: string[]): LoadgenConfig {
  return {
    rpcUrls: getTokenTargets().map(normalizeRpcUrl),
    wallets,
    durationSec: envInt("DURATION_SEC", 30),
    concurrency: Math.max(1, envInt("CONCURRENCY", 6)),
    algorithm: process.env.GCR_IDENTITY_ALGO?.trim() || "falcon",
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
    maxErrorRate: envFloat("MAX_ERROR_RATE", 0.05),
    minLoopDelayMs: Math.max(0, envInt("MIN_LOOP_DELAY_MS", 75)),
    stopOnRateLimit: envBool("STOP_ON_RATE_LIMIT", true),
    // PQC add/remove visibility is block-driven. With a 10s default block time,
    // a serialized add/remove cycle can legitimately span two consensus rounds.
    settleTimeoutSec: Math.max(1, envInt("SETTLE_TIMEOUT_SEC", 20)),
    settlePollMs: Math.max(50, envInt("SETTLE_POLL_MS", 200)),
    opTimeoutMs: Math.max(1000, envInt("GCR_OP_TIMEOUT_MS", 15000)),
  }
}

async function withTimeout<T>(label: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RpcTimeoutError("runtime", label, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function classifyFailure(error: unknown): keyof Pick<LoadgenCounters, "confirmError" | "broadcastError" | "validationError" | "networkError" | "rateLimited"> {
  const info = normalizeLoadgenError(error)
  switch (info.code) {
    case "RATE_LIMIT":
      return "rateLimited"
    case "VALIDATION":
      return "validationError"
    case "CONFIRM":
      return "confirmError"
    case "BROADCAST":
      return "broadcastError"
    default:
      return "networkError"
  }
}

function parseMaybeJson(value: any): any {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch (error) {
    logNonCriticalErrorOnce("gcr_identity_loadgen.parseMaybeJson", "gcr_identity_loadgen.parseMaybeJson", error)
    return value
  }
}

async function executeTx(demos: Demos, payload: any, extra: "confirmTx" | "broadcastTx") {
  const response = await (demos as any).call("execute", "", payload, extra)
  return {
    ...response,
    response: parseMaybeJson(response?.response),
  }
}

function buildIdentityAddress(workerId: number, sequence: number): string {
  const prefix = Date.now().toString(16).slice(-8).padStart(8, "0")
  const worker = workerId.toString(16).padStart(4, "0")
  const seq = sequence.toString(16).padStart(8, "0")
  const raw = (prefix + worker + seq).padStart(64, "0").slice(-64)
  return normalizeHexAddress("0x" + raw)
}

async function submitPqcTx(params: {
  demos: Demos
  ownerAddress: string
  algorithm: string
  identityAddress: string
  operation: "add" | "remove"
  opTimeoutMs: number
}) {
  const nonce = Number(
    await withTimeout(
      `getAddressNonce(${params.operation})`,
      params.opTimeoutMs,
      params.demos.getAddressNonce(params.ownerAddress),
    ),
  ) + 1
  const timestamp = Date.now()
  const tx = (params.demos as any).tx.empty()
  tx.content.type = "identity"
  tx.content.to = params.ownerAddress
  tx.content.amount = 0
  tx.content.nonce = nonce
  tx.content.timestamp = timestamp

  const payload = params.operation === "add"
    ? [{
      algorithm: params.algorithm,
      address: params.identityAddress,
      signature: uint8ArrayToHex(
        (
          await params.demos.crypto.sign(
            "ed25519",
            new TextEncoder().encode(params.identityAddress),
          )
        ).signature,
      ),
      timestamp,
    }]
    : [{ algorithm: params.algorithm, address: params.identityAddress }]

  tx.content.data = [
    "identity",
    {
      method: params.operation === "add" ? "pqc_identity_assign" : "pqc_identity_remove",
      context: "pqc",
      payload,
    },
  ]
  tx.content.from = params.ownerAddress
  tx.content.from_ed25519_address = params.ownerAddress

  const signedTx = await withTimeout(
    `sign(${params.operation})`,
    params.opTimeoutMs,
    (params.demos as any).sign(tx),
  )
  const validity = await withTimeout(
    `confirmTx(${params.operation})`,
    params.opTimeoutMs,
    executeTx(params.demos, signedTx, "confirmTx"),
  )
  if (validity?.error) {
    throw loadgenErrorFromMessage(extractTransportErrorMessage("confirm transport failed", params.operation, validity), {
      operation: params.operation,
      ownerAddress: params.ownerAddress,
      identityAddress: params.identityAddress,
      response: validity,
    })
  }
  if (validity?.result !== 200 || validity?.response?.data?.valid !== true) {
    throw loadgenErrorFromMessage(`confirm failed (${params.operation}): ${JSON.stringify(validity)}`, {
      operation: params.operation,
      ownerAddress: params.ownerAddress,
      identityAddress: params.identityAddress,
      response: validity,
    })
  }
  const broadcast = await withTimeout(
    `broadcastTx(${params.operation})`,
    params.opTimeoutMs,
    executeTx(params.demos, validity, "broadcastTx"),
  )
  if (broadcast?.error) {
    throw loadgenErrorFromMessage(extractTransportErrorMessage("broadcast transport failed", params.operation, broadcast), {
      operation: params.operation,
      ownerAddress: params.ownerAddress,
      identityAddress: params.identityAddress,
      response: broadcast,
    })
  }
  if (broadcast?.result !== 200) {
    throw loadgenErrorFromMessage(`broadcast failed (${params.operation}): ${JSON.stringify(broadcast)}`, {
      operation: params.operation,
      ownerAddress: params.ownerAddress,
      identityAddress: params.identityAddress,
      response: broadcast,
    })
  }
}

async function getPqcIdentitySet(rpcUrl: string, ownerAddress: string, algorithm: string): Promise<Set<string>> {
  const res = await nodeCall(
    rpcUrl,
    "getAddressInfo",
    { address: ownerAddress },
    `gcr:getAddressInfo:loadgen:${ownerAddress}`,
    NO_FALLBACKS,
  )
  if (res?.result !== 200) return new Set()
  const list = res?.response?.identities?.pqc?.[algorithm]
  if (!Array.isArray(list)) return new Set()
  return new Set(list.map((item: any) => normalizeHexAddress(item?.address ?? "")).filter(Boolean))
}

async function waitForIdentityPresence(params: {
  rpcUrl: string
  ownerAddress: string
  algorithm: string
  identityAddress: string
  expectPresent: boolean
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const target = normalizeHexAddress(params.identityAddress)
  while (nowMs() < deadlineMs) {
    const set = await getPqcIdentitySet(params.rpcUrl, params.ownerAddress, params.algorithm)
    const present = set.has(target)
    if (present === params.expectPresent) return
    await sleep(params.pollMs)
  }
  throw new ConvergenceError(
    `settle failed: identity ${params.expectPresent ? "not visible" : "still visible"} after ${params.timeoutSec}s`,
    {
      rpcUrl: params.rpcUrl,
      ownerAddress: params.ownerAddress,
      algorithm: params.algorithm,
      identityAddress: params.identityAddress,
      expectPresent: params.expectPresent,
      timeoutSec: params.timeoutSec,
    },
  )
}

function pushErrorSample(samples: ErrorSample[], stage: ErrorSample["stage"], error: unknown) {
  if (samples.length >= 10) return
  const info = normalizeLoadgenError(error)
  samples.push({
    at: new Date().toISOString(),
    stage,
    message: info.message,
    code: info.code,
    retryable: info.retryable,
    context: info.context ?? null,
  })
}

async function worker(params: {
  workerId: number
  rpcUrl: string
  walletMnemonic: string
  stopAtMs: number
  algorithm: string
  counters: LoadgenCounters
  sampler: ReservoirSampler
  timeseriesSampler: ReservoirSampler
  sharedStop: { value: boolean }
  cfg: LoadgenConfig
  errorSamples: ErrorSample[]
}): Promise<WorkerReport> {
  const demos = new Demos()
  let ownerAddress = ""
  const outstanding = new Set<string>()
  let sequence = 0
  let iterations = 0

  try {
    await waitForRpcReady(params.rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
    await waitForTxReady(params.rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
    await withTimeout(`demos.connect(worker:${params.workerId})`, params.cfg.opTimeoutMs, demos.connect(params.rpcUrl))
    await withTimeout(
      `demos.connectWallet(worker:${params.workerId})`,
      params.cfg.opTimeoutMs,
      demos.connectWallet(params.walletMnemonic, { algorithm: "ed25519" }),
    )

    const { publicKey } = await withTimeout(
      `crypto.getIdentity(worker:${params.workerId})`,
      params.cfg.opTimeoutMs,
      demos.crypto.getIdentity("ed25519"),
    )
    ownerAddress = uint8ArrayToHex(publicKey)
  } catch (error) {
    params.counters.total++
    params.counters.networkError++
    pushErrorSample(
      params.errorSamples,
      "confirm",
      new SetupError(`worker startup failed (${params.workerId}): ${error instanceof Error ? error.message : String(error)}`, {
        workerId: params.workerId,
        rpcUrl: params.rpcUrl,
      }),
    )
    return {
      workerId: params.workerId,
      rpcUrl: params.rpcUrl,
      ownerAddress,
      iterations,
      generated: sequence,
      outstanding: [],
      fatalError: error instanceof Error ? error.message : String(error),
    }
  }

  while (nowMs() < params.stopAtMs && !params.sharedStop.value) {
    const identityAddress = buildIdentityAddress(params.workerId, sequence++)
    const started = performance.now()
    params.counters.total++
    try {
      await submitPqcTx({
        demos,
        ownerAddress,
        algorithm: params.algorithm,
        identityAddress,
        operation: "add",
        opTimeoutMs: params.cfg.opTimeoutMs,
      })
      outstanding.add(identityAddress)
      await waitForIdentityPresence({
        rpcUrl: params.rpcUrl,
        ownerAddress,
        algorithm: params.algorithm,
        identityAddress,
        expectPresent: true,
        timeoutSec: params.cfg.settleTimeoutSec,
        pollMs: params.cfg.settlePollMs,
      })

      await submitPqcTx({
        demos,
        ownerAddress,
        algorithm: params.algorithm,
        identityAddress,
        operation: "remove",
        opTimeoutMs: params.cfg.opTimeoutMs,
      })
      outstanding.delete(identityAddress)
      await waitForIdentityPresence({
        rpcUrl: params.rpcUrl,
        ownerAddress,
        algorithm: params.algorithm,
        identityAddress,
        expectPresent: false,
        timeoutSec: params.cfg.settleTimeoutSec,
        pollMs: params.cfg.settlePollMs,
      })

      const elapsed = performance.now() - started
      params.counters.ok++
      params.sampler.add(elapsed)
      params.timeseriesSampler.add(elapsed)
      iterations++
    } catch (error) {
      const elapsed = performance.now() - started
      params.sampler.add(elapsed)
      params.timeseriesSampler.add(elapsed)
      const bucket = classifyFailure(error)
      params.counters[bucket]++
      pushErrorSample(params.errorSamples, bucket === "broadcastError" ? "broadcast" : "confirm", error)
      if (bucket === "rateLimited" && params.cfg.stopOnRateLimit) {
        params.sharedStop.value = true
      }
      await sleep(Math.max(25, params.cfg.minLoopDelayMs))
    }
    if (params.cfg.minLoopDelayMs > 0) await sleep(params.cfg.minLoopDelayMs)
  }

  return {
    workerId: params.workerId,
    rpcUrl: params.rpcUrl,
    ownerAddress,
    iterations,
    generated: sequence,
    outstanding: Array.from(outstanding.values()),
  }
}

async function probeWalletIdentities(params: {
  rpcUrl: string
  wallets: string[]
  count: number
  opTimeoutMs: number
}): Promise<WalletIdentityProbe[]> {
  const probes: WalletIdentityProbe[] = []
  for (let idx = 0; idx < Math.min(params.count, params.wallets.length); idx++) {
    const demos = new Demos()
    await withTimeout(`preflight.connect(${idx})`, params.opTimeoutMs, demos.connect(params.rpcUrl))
    await withTimeout(
      `preflight.connectWallet(${idx})`,
      params.opTimeoutMs,
      demos.connectWallet(params.wallets[idx]!, { algorithm: "ed25519" }),
    )
    const { publicKey } = await withTimeout(
      `preflight.crypto.getIdentity(${idx})`,
      params.opTimeoutMs,
      demos.crypto.getIdentity("ed25519"),
    )
    probes.push({
      mnemonicIndex: idx,
      ownerAddress: uint8ArrayToHex(publicKey),
    })
  }
  return probes
}

export async function runGcrIdentityLoadgen() {
  maybeSilenceConsole()

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("gcr_identity_loadgen requires at least 1 wallet")

  const cfg = getConfig(wallets)
  await Promise.all(cfg.rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))
  await Promise.all(cfg.rpcUrls.map(url => waitForTxReady(url, envInt("WAIT_FOR_TX_SEC", 120))))

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/features/gcr/gcr_identity_loadgen`
  const artifacts = {
    summaryPath: `${artifactBase}.summary.json`,
    timeseriesPath: `${artifactBase}.timeseries.jsonl`,
  }

  const counters: LoadgenCounters = {
    startedAtMs: nowMs(),
    endedAtMs: 0,
    total: 0,
    ok: 0,
    confirmError: 0,
    broadcastError: 0,
    validationError: 0,
    networkError: 0,
    rateLimited: 0,
    cleanupError: 0,
  }
  const errorSamples: ErrorSample[] = []

  const sampler = new ReservoirSampler(cfg.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)
  const stopAtMs = counters.startedAtMs + cfg.durationSec * 1000
  const workerCount = Math.max(1, cfg.concurrency)

  const preflightWallets =
    workerCount > 1
      ? await probeWalletIdentities({
        rpcUrl: cfg.rpcUrls[0]!,
        wallets: cfg.wallets,
        count: workerCount,
        opTimeoutMs: cfg.opTimeoutMs,
      })
      : []
  const preflightUnique = new Set(preflightWallets.map(item => item.ownerAddress.toLowerCase()))
  const preflightOk = preflightWallets.length <= 1 || preflightUnique.size === preflightWallets.length

  if (!preflightOk) {
    counters.total = preflightWallets.length
    counters.networkError = preflightWallets.length
    counters.endedAtMs = nowMs()
    pushErrorSample(
      errorSamples,
      "confirm",
      new SetupError(
        "wallet identity preflight failed: multiple Demos instances resolved to the same ed25519 identity; concurrent multi-wallet load is not trustworthy in this process",
        { wallets: preflightWallets },
      ),
    )
    const summary = {
      scenario: "gcr_identity_loadgen",
      ok: false,
      config: cfg,
      elapsedSec: Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000),
      counters,
      errorCount: counters.networkError,
      errorRate: 1,
      latencyMs: summarizeLatency(sampler.snapshotSorted()),
      rps: 0,
      okRps: 0,
      workerReports: [],
      finalChecks: [],
      leakedIdentities: [],
      errorSamples,
      preflight: {
        ok: false,
        wallets: preflightWallets,
      },
      artifacts,
      timestamp: new Date().toISOString(),
    }
    writeJson(artifacts.summaryPath, summary)
    console.log(JSON.stringify({ gcr_identity_loadgen_summary: summary }, null, 2))
    throw new Error("gcr_identity_loadgen failed: concurrent wallet preflight detected shared SDK identity state")
  }

  let lastPointAtMs = counters.startedAtMs
  let lastOk = 0
  let lastTotal = 0
  let lastConfirm = 0
  let lastBroadcast = 0
  let lastValidation = 0
  let lastNetwork = 0
  let lastRateLimited = 0

  async function timeseriesLoop() {
    if (!cfg.emitTimeseries) return
    while (nowMs() < stopAtMs) {
      await sleep(1000)
      const now = nowMs()
      const elapsedSinceLast = Math.max(0.001, (now - lastPointAtMs) / 1000)
      lastPointAtMs = now

      const okDelta = counters.ok - lastOk
      const totalDelta = counters.total - lastTotal
      const confirmDelta = counters.confirmError - lastConfirm
      const broadcastDelta = counters.broadcastError - lastBroadcast
      const validationDelta = counters.validationError - lastValidation
      const networkDelta = counters.networkError - lastNetwork
      const rateLimitedDelta = counters.rateLimited - lastRateLimited

      lastOk = counters.ok
      lastTotal = counters.total
      lastConfirm = counters.confirmError
      lastBroadcast = counters.broadcastError
      lastValidation = counters.validationError
      lastNetwork = counters.networkError
      lastRateLimited = counters.rateLimited

      const point: TimeseriesPoint = {
        tSec: (now - counters.startedAtMs) / 1000,
        ok: okDelta,
        total: totalDelta,
        confirmError: confirmDelta,
        broadcastError: broadcastDelta,
        validationError: validationDelta,
        networkError: networkDelta,
        rateLimited: rateLimitedDelta,
        tps: totalDelta / elapsedSinceLast,
        okTps: okDelta / elapsedSinceLast,
        latencyMs: summarizeLatency(timeseriesSampler.snapshotSorted()),
        timestamp: new Date().toISOString(),
      }
      appendJsonl(artifacts.timeseriesPath, point)
    }
  }

  const sharedStop = { value: false }
  const workers = Array.from({ length: workerCount }, (_, idx) =>
    worker({
      workerId: idx,
      rpcUrl: cfg.rpcUrls[idx % cfg.rpcUrls.length]!,
      walletMnemonic: cfg.wallets[idx % cfg.wallets.length]!,
      stopAtMs,
      algorithm: cfg.algorithm,
      counters,
      sampler,
      timeseriesSampler,
      sharedStop,
      cfg,
      errorSamples,
    }),
  )

  const timeseriesPromise = timeseriesLoop()
  const workerReports = await Promise.all(workers)
  await timeseriesPromise
  counters.endedAtMs = nowMs()

  const finalChecks: Array<{ ownerAddress: string; stillPresent: string[] }> = []
  for (const report of workerReports) {
    for (const address of report.outstanding) {
      try {
        const demos = new Demos()
        await withTimeout(`cleanup.connect(worker:${report.workerId})`, cfg.opTimeoutMs, demos.connect(report.rpcUrl))
        await withTimeout(
          `cleanup.connectWallet(worker:${report.workerId})`,
          cfg.opTimeoutMs,
          demos.connectWallet(cfg.wallets[report.workerId % cfg.wallets.length]!, { algorithm: "ed25519" }),
        )
        await submitPqcTx({
          demos,
          ownerAddress: report.ownerAddress,
          algorithm: cfg.algorithm,
          identityAddress: address,
          operation: "remove",
          opTimeoutMs: cfg.opTimeoutMs,
        })
      } catch (error) {
        counters.cleanupError++
        pushErrorSample(errorSamples, "cleanup", error)
        logNonCriticalError("gcr_identity_loadgen.cleanup", error, {
          workerId: report.workerId,
          rpcUrl: report.rpcUrl,
          ownerAddress: report.ownerAddress,
          identityAddress: address,
        })
      }
    }

    const existing = await getPqcIdentitySet(report.rpcUrl, report.ownerAddress, cfg.algorithm)
    const stillPresent = report.outstanding.filter(address => existing.has(normalizeHexAddress(address)))
    finalChecks.push({ ownerAddress: report.ownerAddress, stillPresent })
  }

  const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
  const errorCount =
    counters.confirmError +
    counters.broadcastError +
    counters.validationError +
    counters.networkError +
    counters.rateLimited +
    counters.cleanupError
  const errorRate = counters.total > 0 ? errorCount / counters.total : 1
  const leakedIdentities = finalChecks.flatMap(check => check.stillPresent)
  const sampleCodeCounts = errorSamples.reduce<Record<string, number>>((acc, sample) => {
    const key = sample.code ?? "UNKNOWN"
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const operatorSummary = {
    primaryIssues: [
      counters.rateLimited > 0 || (sampleCodeCounts.RATE_LIMIT ?? 0) > 0 ? "rate_limit" : null,
      counters.validationError > 0 || (sampleCodeCounts.VALIDATION ?? 0) > 0 ? "validation" : null,
      counters.confirmError > 0 || counters.broadcastError > 0 ? "tx_pipeline" : null,
      counters.networkError > 0 ? "network" : null,
      counters.cleanupError > 0 ? "cleanup" : null,
      leakedIdentities.length > 0 ? "leaked_identities" : null,
    ].filter(Boolean),
    counterWarnings: [
      counters.rateLimited === 0 && (sampleCodeCounts.RATE_LIMIT ?? 0) > 0
        ? "rate-limit samples were observed even though counters.rateLimited remained 0"
        : null,
    ].filter(Boolean),
    sampleCodeCounts,
  }
  const ok = counters.total > 0 && errorRate <= cfg.maxErrorRate && leakedIdentities.length === 0

  const summary = {
    scenario: "gcr_identity_loadgen",
    ok,
    config: cfg,
    elapsedSec,
    counters,
    errorCount,
    errorRate,
    latencyMs: summarizeLatency(sampler.snapshotSorted()),
    rps: counters.total / elapsedSec,
    okRps: counters.ok / elapsedSec,
    workerReports,
    finalChecks,
    leakedIdentities,
    errorSamples,
    operatorSummary,
    preflight: {
      ok: true,
      wallets: preflightWallets,
    },
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ gcr_identity_loadgen_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("gcr_identity_loadgen failed: error rate exceeded threshold or leaked identities detected")
  }
}

if (import.meta.main) {
  await runGcrIdentityLoadgen()
}
