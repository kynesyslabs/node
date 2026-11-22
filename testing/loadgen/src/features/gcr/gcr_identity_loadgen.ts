import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { appendJsonl, getRunConfig, writeJson } from "../../framework/io"
import { ReservoirSampler, summarizeLatency } from "../../framework/metrics"
import { envBool, envFloat, envInt, logNonCriticalError, logNonCriticalErrorOnce, normalizeHexAddress, normalizeRpcUrl, nowMs, sleep } from "../../framework/common"
import { BroadcastError, ConfirmError, ConvergenceError, RateLimitError, RpcTimeoutError, SetupError, loadgenErrorFromMessage, normalizeLoadgenError } from "../../framework/errors"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import {
  getTokenTargets,
  maybeSilenceConsole,
  readWalletMnemonics,
  waitForRpcReady,
  waitForTxReady,
} from "../../token_shared"

export type LoadgenConfig = {
  rpcUrls: string[]
  /** rpcUrls without repeats (first occurrence kept): workers are spread over it and the cap counts it. */
  targetUrls: string[]
  wallets: string[]
  durationSec: number
  concurrency: number
  workerCap: number
  algorithm: string
  sampleLimit: number
  emitTimeseries: boolean
  maxErrorRate: number
  minLoopDelayMs: number
  stopOnRateLimit: boolean
  rateLimitMaxRetries: number
  settleTimeoutSec: number
  settlePollMs: number
  opTimeoutMs: number
}

type WalletIdentityProbe = {
  mnemonicIndex: number
  ownerAddress: string
}

export type LoadgenCounters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  confirmError: number
  broadcastError: number
  validationError: number
  networkError: number
  rateLimited: number
  /**
   * Steps an identity confirm cap 429 left unfinished because the run deadline
   * cut off a retry that was still allowed (isCutOffAtDeadline). Counted in
   * total, but not errors.
   */
  rateLimitedAtDeadline: number
  /** Cap 429 retries: one per retry started after the new block showed up; not errors. */
  rateLimitRetries: number
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

export type TimeseriesPoint = {
  tSec: number
  ok: number
  total: number
  confirmError: number
  broadcastError: number
  validationError: number
  networkError: number
  rateLimited: number
  rateLimitedAtDeadline: number
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

/**
 * HTTP status of a failed `demos.call`. The SDK does not throw: it returns
 * `{ result: 500, response: TransportError }`, and the node's status (e.g. the
 * 429 of the identity confirm cap) is only on the error's axios `cause`.
 */
export function httpStatusOf(response: any): number | null {
  const status = response?.response?.cause?.response?.status ?? response?.response?.cause?.status
  return typeof status === "number" ? status : null
}

/**
 * Which node limiter sent an HTTP 429. Both answer 429 with "Rate limit
 * exceeded". The identity confirm cap (src/libs/network/rpcRateLimit.ts) sends
 * no Retry-After header and body retryAfter null; the next block frees it. The
 * general limiter (src/libs/network/middleware/rateLimiter.ts) blocks the
 * address for some seconds and sends a Retry-After header and a numeric
 * retryAfter. Only the cap's own reply is "identity_cap": no Retry-After
 * header and a body whose retryAfter is null. Every other 429 is "ip_block"
 * and is not retried: the general limiter's, and one from anything else, such
 * as a reverse proxy's HTML page, a JSON body without retryAfter, or an empty
 * body (the SDK transport gives it as data ""). A reply object with no data
 * at all also counts as the cap, but the SDK transport does not produce one.
 */
export function http429LimiterOf(response: any): "identity_cap" | "ip_block" {
  const reply = response?.response?.cause?.response
  const capReply = reply?.headers?.["retry-after"] == null && (reply?.data == null || reply.data.retryAfter === null)
  return capReply ? "identity_cap" : "ip_block"
}

function throwIfRateLimited(label: string, operation: "add" | "remove", response: any, context: Record<string, unknown>) {
  const httpStatus = httpStatusOf(response)
  if (response?.result !== 429 && httpStatus !== 429) return
  const limiter = httpStatus === 429 ? http429LimiterOf(response) : null
  throw new RateLimitError(`${label} (${operation}): node answered HTTP 429 (rate limit)`, { ...context, status: 429, httpStatus, limiter })
}

/** Only the identity confirm cap's HTTP 429 (httpStatusOf, http429LimiterOf) qualifies for block-based retries. */
function isIdentityCapRateLimit(error: unknown): boolean {
  const info = normalizeLoadgenError(error)
  return info.code === "RATE_LIMIT" && info.context?.httpStatus === 429 && info.context?.limiter === "identity_cap"
}

/**
 * Identity confirms (`execute` / `confirmTx` with identity data) one source
 * address may send to one node per block. Mirrors the node's
 * RATE_LIMIT_TX_PER_BLOCK (src/utilities/constants.ts, enforced in
 * src/libs/network/rpcRateLimit.ts); any further confirm in that block gets
 * HTTP 429. Every worker in this process shares one source address.
 */
export const IDENTITY_CONFIRMS_PER_BLOCK = 4

/**
 * How many workers to start. Each worker sends at most one identity confirm per
 * block (every add and remove waits for the next block to show it), and workers
 * are spread round-robin over the distinct targets, so up to 4 workers per target
 * normally stays within the node's cap. A 429 can still occur when the node's
 * limiter has not yet seen the new block: the limiter counts per shared-state
 * lastBlockNumber, while a worker moves on once the stored chain shows the block
 * (its identity change, or getLastBlockNumber after a 429). That 429 is retried
 * (retryOnRateLimit). The default is the smaller of that cap and the wallet
 * count: no more than one worker per wallet, since workers sharing a wallet
 * race on its nonce. An explicit CONCURRENCY at or below that default is used
 * as given. One above it (the Docker perf compose passes 50) is clamped to it
 * (clampedFrom is the requested number, clampedBy the limit that applied: the
 * cap, or the wallet count when that is smaller), unless overCap
 * (GCR_IDENTITY_OVER_CAP=true) is set; then it is used as given (see
 * workerCountWarnings).
 */
export function resolveWorkerCount(params: {
  requested: string | undefined
  targetCount: number
  walletCount: number
  overCap?: boolean
}): { workers: number; cap: number; clampedFrom?: number; clampedBy?: "cap" | "wallets" } {
  const cap = IDENTITY_CONFIRMS_PER_BLOCK * Math.max(1, params.targetCount)
  const limit = Math.max(1, Math.min(cap, params.walletCount))
  const parsed = params.requested ? Number.parseInt(params.requested, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return { workers: limit, cap }
  const requested = Math.max(1, parsed)
  if (requested > limit && !params.overCap) {
    return { workers: limit, cap, clampedFrom: requested, clampedBy: params.walletCount < cap ? "wallets" : "cap" }
  }
  return { workers: requested, cap }
}

/**
 * Distinct nodes in TARGETS, in order with the first occurrence kept: a
 * repeated URL is the same node with the same cap.
 */
function distinctTargets(rpcUrls: string[]): string[] {
  return [...new Set(rpcUrls.map(normalizeRpcUrl))]
}

/** The node worker `idx` sends to: round-robin over the distinct targets. */
export function workerRpcUrl(cfg: Pick<LoadgenConfig, "targetUrls">, idx: number): string {
  return cfg.targetUrls[idx % cfg.targetUrls.length]
}

/**
 * Warnings for the configured worker count: above the identity confirm cap
 * (config.workerCap), and more workers than wallets. resolveWorkerCount
 * clamps to both unless GCR_IDENTITY_OVER_CAP=true, so without the flag only a
 * run with no wallet gets the second one.
 */
export function workerCountWarnings(cfg: Pick<LoadgenConfig, "concurrency" | "workerCap" | "rpcUrls" | "wallets">): string[] {
  const warnings: string[] = []
  if (cfg.concurrency > cfg.workerCap) {
    warnings.push(
      `[gcr_identity_loadgen] CONCURRENCY=${cfg.concurrency} is above ${cfg.workerCap} (${IDENTITY_CONFIRMS_PER_BLOCK} identity confirms per block per node x ${Math.max(1, distinctTargets(cfg.rpcUrls).length)} target(s) from one source address). ` +
        "The nodes will answer the extra confirms with HTTP 429; workers wait for the next block and retry " +
        "(with STOP_ON_RATE_LIMIT=true the first 429 stops the run instead).",
    )
  }
  if (cfg.concurrency > cfg.wallets.length) {
    warnings.push(
      `[gcr_identity_loadgen] ${cfg.concurrency} workers but ${cfg.wallets.length} wallet(s): workers will share wallets and their nonces.`,
    )
  }
  return warnings
}

export function getConfig(wallets: string[]): LoadgenConfig {
  // rpcUrls stays as given; workers are spread over targetUrls (see workerRpcUrl).
  const rpcUrls = getTokenTargets().map(normalizeRpcUrl)
  const targetUrls = distinctTargets(rpcUrls)
  const workerCount = resolveWorkerCount({
    requested: process.env.CONCURRENCY,
    targetCount: targetUrls.length,
    walletCount: wallets.length,
    overCap: envBool("GCR_IDENTITY_OVER_CAP", false),
  })
  const clampNotice =
    workerCount.clampedFrom === undefined
      ? []
      : [
          `[gcr_identity_loadgen] CONCURRENCY=${workerCount.clampedFrom} is above ` +
            (workerCount.clampedBy === "wallets"
              ? `the wallet count of ${wallets.length} (workers sharing a wallet race on its nonce); `
              : `the identity confirm cap of ${workerCount.cap}; `) +
            `using ${workerCount.workers}, set GCR_IDENTITY_OVER_CAP=true to keep ${workerCount.clampedFrom}.`,
        ]
  const config: LoadgenConfig = {
    rpcUrls,
    targetUrls,
    wallets,
    durationSec: envInt("DURATION_SEC", 30),
    concurrency: workerCount.workers,
    workerCap: workerCount.cap,
    algorithm: process.env.GCR_IDENTITY_ALGO?.trim() || "falcon",
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
    maxErrorRate: envFloat("MAX_ERROR_RATE", 0.05),
    minLoopDelayMs: Math.max(0, envInt("MIN_LOOP_DELAY_MS", 75)),
    // A 429 is back-pressure: wait for the next block and retry the step.
    // STOP_ON_RATE_LIMIT=true restores the old behaviour (first 429 ends the run).
    stopOnRateLimit: envBool("STOP_ON_RATE_LIMIT", false),
    // Blocks one step may wait out before its 429 counts as an error.
    rateLimitMaxRetries: Math.max(0, envInt("RATE_LIMIT_MAX_RETRIES", 10)),
    // PQC add/remove visibility is block-driven. With a 10s default block time,
    // a serialized add/remove cycle can legitimately span two consensus rounds.
    settleTimeoutSec: Math.max(1, envInt("SETTLE_TIMEOUT_SEC", 20)),
    settlePollMs: Math.max(50, envInt("SETTLE_POLL_MS", 200)),
    opTimeoutMs: Math.max(1000, envInt("GCR_OP_TIMEOUT_MS", 15000)),
  }
  // The clamp notice and warnings are meant for the operator running the loadgen.
  // eslint-disable-next-line no-console
  for (const warning of [...clampNotice, ...workerCountWarnings(config)]) console.warn(warning)
  return config
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

/** Set by retryOnRateLimit on a 429 whose retry the run deadline cut off (isCutOffAtDeadline). */
type CutOffMark = { cutOffAtDeadline?: true }

function markCutOffAtDeadline(error: unknown): unknown {
  if (error instanceof Error) (error as Error & CutOffMark).cutOffAtDeadline = true
  return error
}

/** Whether retryOnRateLimit gave up on this identity confirm cap 429 only because the run ended. */
export function isCutOffAtDeadline(error: unknown): boolean {
  return error instanceof Error && (error as Error & CutOffMark).cutOffAtDeadline === true
}

/**
 * Counts a worker step that failed. Only an identity confirm cap HTTP 429
 * whose retry the run deadline cut off (isCutOffAtDeadline: retryOnRateLimit
 * would have waited for the next block and sent the step again, but the run
 * had ended) goes to rateLimitedAtDeadline: the node did not refuse the step
 * for good, the run just ended before the retry. The step stays in total as
 * unfinished, and errorRateOf leaves it out. It is not an error, but a run
 * with no successful step still fails (runVerdict). Every other 429 counts in
 * rateLimited as an error, whenever it arrives: one with no retry left
 * (RATE_LIMIT_MAX_RETRIES used up, or 0), one whose block wait timed out,
 * every 429 when stopOnRateLimit is set, and the other rate-limit errors,
 * which are not retried.
 */
export function countStepFailure(counters: LoadgenCounters, error: unknown) {
  const bucket = isCutOffAtDeadline(error) ? "rateLimitedAtDeadline" : classifyFailure(error)
  counters[bucket]++
  return bucket
}

/**
 * Errors over the finished steps, checked against MAX_ERROR_RATE. A step in
 * rateLimitedAtDeadline did not finish: it is neither an error nor in the
 * denominator. With no finished step the rate is 1, and runVerdict also fails
 * a run with no successful step.
 */
export function errorRateOf(counters: LoadgenCounters): { errorCount: number; errorRate: number } {
  const errorCount =
    counters.confirmError +
    counters.broadcastError +
    counters.validationError +
    counters.networkError +
    counters.rateLimited +
    counters.cleanupError
  const finished = counters.total - counters.rateLimitedAtDeadline
  return { errorCount, errorRate: finished > 0 ? errorCount / finished : 1 }
}

/**
 * Whether the run passes, and its primary issues. It passes when at least one
 * step succeeded, the error rate is within MAX_ERROR_RATE and no identity
 * leaked. A 429 cut off at the run deadline is not an error, but it is listed
 * as a rate_limit issue, and a run with no successful step fails.
 */
export function runVerdict(params: {
  counters: LoadgenCounters
  maxErrorRate: number
  leakedIdentityCount: number
  sampleCodeCounts: Record<string, number>
}): { ok: boolean; primaryIssues: string[] } {
  const { counters, sampleCodeCounts } = params
  const primaryIssues = [
    counters.rateLimited > 0 || counters.rateLimitedAtDeadline > 0 || (sampleCodeCounts.RATE_LIMIT ?? 0) > 0 ? "rate_limit" : null,
    counters.validationError > 0 || (sampleCodeCounts.VALIDATION ?? 0) > 0 ? "validation" : null,
    counters.confirmError > 0 || counters.broadcastError > 0 ? "tx_pipeline" : null,
    counters.networkError > 0 ? "network" : null,
    counters.cleanupError > 0 ? "cleanup" : null,
    params.leakedIdentityCount > 0 ? "leaked_identities" : null,
  ].filter((issue): issue is string => issue !== null)
  const ok =
    counters.total > 0 &&
    counters.ok > 0 &&
    errorRateOf(counters).errorRate <= params.maxErrorRate &&
    params.leakedIdentityCount === 0
  return { ok, primaryIssues }
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

export async function submitPqcTx(params: {
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
  const errorContext = {
    operation: params.operation,
    ownerAddress: params.ownerAddress,
    identityAddress: params.identityAddress,
  }
  throwIfRateLimited("confirm", params.operation, validity, errorContext)
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
  throwIfRateLimited("broadcast", params.operation, broadcast, errorContext)
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

/** Reads an owner's PQC identities of one algorithm (getPqcIdentitySet). */
export type ReadIdentities = (rpcUrl: string, ownerAddress: string, algorithm: string) => Promise<Set<string>>

/**
 * Time source of the settle and block waits; tests pass a fake one, so they
 * make no real waits. A sleep cancelled by its signal never resolves.
 */
export type WaitClock = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> }

const realClock: WaitClock = {
  now: nowMs,
  sleep: (ms, signal) =>
    new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener("abort", () => clearTimeout(timer), { once: true })
    }),
}

/**
 * Runs a wait's read against the time left before its deadline. A read still
 * pending at the deadline counts as failed (null), so the wait ends by its
 * timeout and does not hold on for the RPC's own abort.
 */
async function readWithin<T>(clock: WaitClock, leftMs: number, read: () => Promise<T>): Promise<T | null> {
  const timer = new AbortController()
  try {
    return await Promise.race([read(), clock.sleep(Math.max(0, leftMs), timer.signal).then(() => null)])
  } finally {
    timer.abort()
  }
}

/**
 * Waits until the identity is present (or absent) as expected, and throws
 * ConvergenceError if it is not within timeoutSec. The wait ends by timeoutSec
 * whatever pollMs is: no sleep runs past the deadline, and a read still
 * pending at the deadline counts as not settled.
 */
export async function waitForIdentityPresence(params: {
  rpcUrl: string
  ownerAddress: string
  algorithm: string
  identityAddress: string
  expectPresent: boolean
  timeoutSec: number
  pollMs: number
  readIdentities?: ReadIdentities
  clock?: WaitClock
}) {
  const clock = params.clock ?? realClock
  const deadlineMs = clock.now() + Math.max(1, params.timeoutSec) * 1000
  const leftMs = () => deadlineMs - clock.now()
  const target = normalizeHexAddress(params.identityAddress)
  const readIdentities = params.readIdentities ?? getPqcIdentitySet
  while (leftMs() > 0) {
    const set = await readWithin(clock, leftMs(), () => readIdentities(params.rpcUrl, params.ownerAddress, params.algorithm))
    if (set !== null && set.has(target) === params.expectPresent) return
    if (leftMs() <= 0) break
    await clock.sleep(Math.min(params.pollMs, leftMs()))
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

async function readLastBlockNumber(rpcUrl: string): Promise<number | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, "gcr:getLastBlockNumber:loadgen", NO_FALLBACKS)
  if (res?.result !== 200) return null
  const value = typeof res.response === "string" ? Number.parseInt(res.response, 10) : res.response
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Reads a node's last block number, or null when the read fails. */
export type ReadBlockNumber = (rpcUrl: string) => Promise<number | null>

/**
 * Waits until the node's last block number moves past start: the identity
 * confirm cap counts per block, so a new block frees the slots. start is the
 * height read before the refused attempt, so a block that landed since counts
 * and the first read is checked at once. With start null, the first good read
 * is the baseline. Returns false if no new block shows up within timeoutMs.
 * The wait ends by timeoutMs whatever pollMs is: no sleep runs past the
 * deadline, and a read still pending at the deadline counts as a failed read.
 */
export async function waitForNextBlock(
  rpcUrl: string,
  timeoutMs: number,
  pollMs: number,
  readBlockNumber: ReadBlockNumber = readLastBlockNumber,
  start: number | null = null,
  clock: WaitClock = realClock,
): Promise<boolean> {
  const deadlineMs = clock.now() + timeoutMs
  const leftMs = () => deadlineMs - clock.now()
  const read = () => readWithin(clock, leftMs(), () => readBlockNumber(rpcUrl))
  let baseline = start ?? (await read())
  let pause = start === null
  while (leftMs() > 0) {
    if (pause) await clock.sleep(Math.min(pollMs, leftMs()))
    pause = true
    if (leftMs() <= 0) break
    const current = await read()
    if (current === null) continue
    if (baseline === null) baseline = current
    else if (current > baseline) return true
  }
  return false
}

export type RateLimitRetry = {
  stopOnRateLimit: boolean
  maxRetries: number
  shouldStop: () => boolean
  /** The target's current block number, or null when the read fails or does not answer in time. */
  readHeight: () => Promise<number | null>
  /** Resolves true once a block past start shows up, false if none did in time. */
  waitForNextBlock: (start: number | null) => Promise<boolean>
  /** Called once per retry started after the new block showed up, just before the step runs again. */
  onRetry: () => void
}

/**
 * Runs one step (a confirm + broadcast). An HTTP 429 from the node's per-block
 * identity confirm cap is back-pressure, so the step is retried after the next
 * block, up to maxRetries times. That block is one past the height read just
 * before the refused attempt, so a block that lands during the refusal counts;
 * the height is read before each attempt that could still be retried. If no
 * new block shows up in time, the 429 is thrown. If the run has ended (shouldStop)
 * before the wait, once the new block shows up, or during the height read
 * before the retry, the 429 is thrown marked as cut off by the deadline
 * (isCutOffAtDeadline), since another attempt was still allowed. The general
 * limiter's 429 (http429LimiterOf), rate-limit messages without an HTTP 429,
 * other errors, every 429 when stopOnRateLimit is set, and a 429 with no
 * retry left, are thrown to the caller unmarked.
 */
export async function retryOnRateLimit<T>(step: () => Promise<T>, opts: RateLimitRetry): Promise<T> {
  // With retries off, no height is read.
  const canRetry = !opts.stopOnRateLimit && opts.maxRetries > 0
  let refused: unknown
  for (let attempt = 0; ; attempt++) {
    const start = canRetry && attempt < opts.maxRetries ? await opts.readHeight() : null
    if (attempt > 0) {
      // The run ended during the height read: do not send the retry.
      if (opts.shouldStop()) throw markCutOffAtDeadline(refused)
      opts.onRetry()
    }
    try {
      return await step()
    } catch (error) {
      const retryAllowed = isIdentityCapRateLimit(error) && !opts.stopOnRateLimit && attempt < opts.maxRetries
      if (!retryAllowed) throw error
      if (opts.shouldStop()) throw markCutOffAtDeadline(error)
      // No new block in time: the cap is still spent, so do not start another step.
      if (!(await opts.waitForNextBlock(start))) throw error
      // The run ended during the wait: do not start another step.
      if (opts.shouldStop()) throw markCutOffAtDeadline(error)
      refused = error
    }
  }
}

function rateLimitRetryFor(params: {
  rpcUrl: string
  cfg: LoadgenConfig
  counters: LoadgenCounters
  shouldStop: () => boolean
  stopOnRateLimit: boolean
  readBlockNumber?: ReadBlockNumber
  clock?: WaitClock
}): RateLimitRetry {
  const readBlockNumber = params.readBlockNumber ?? readLastBlockNumber
  const clock = params.clock ?? realClock
  return {
    stopOnRateLimit: params.stopOnRateLimit,
    maxRetries: params.cfg.rateLimitMaxRetries,
    shouldStop: params.shouldStop,
    // A read still pending after opTimeoutMs gives null, so the step goes out.
    readHeight: () => readWithin(clock, params.cfg.opTimeoutMs, () => readBlockNumber(params.rpcUrl)),
    waitForNextBlock: start =>
      waitForNextBlock(params.rpcUrl, params.cfg.settleTimeoutSec * 1000, params.cfg.settlePollMs, readBlockNumber, start, clock),
    onRetry: () => {
      params.counters.rateLimitRetries++
    },
  }
}

/** A worker's retry: it also ends at the run deadline, so a step waiting out 429s sends no retry after the run deadline. */
export function workerRateLimitRetry(params: {
  rpcUrl: string
  cfg: LoadgenConfig
  counters: LoadgenCounters
  sharedStop: { value: boolean }
  stopAtMs: number
  readBlockNumber?: ReadBlockNumber
  clock?: WaitClock
}): RateLimitRetry {
  return rateLimitRetryFor({
    rpcUrl: params.rpcUrl,
    cfg: params.cfg,
    counters: params.counters,
    shouldStop: () => params.sharedStop.value || nowMs() >= params.stopAtMs,
    stopOnRateLimit: params.cfg.stopOnRateLimit,
    readBlockNumber: params.readBlockNumber,
    clock: params.clock,
  })
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

/**
 * Counts a failed worker step. A step cut off at the deadline did not finish:
 * it adds no latency sample and no error sample. Every other failed step adds
 * its latency sample (a retried step's includes its block waits).
 */
export function recordStepFailure(
  params: { counters: LoadgenCounters; sampler: ReservoirSampler; timeseriesSampler: ReservoirSampler; errorSamples: ErrorSample[] },
  error: unknown,
  elapsed: number,
) {
  const bucket = countStepFailure(params.counters, error)
  if (bucket !== "rateLimitedAtDeadline") {
    params.sampler.add(elapsed)
    params.timeseriesSampler.add(elapsed)
    pushErrorSample(params.errorSamples, bucket === "broadcastError" ? "broadcast" : "confirm", error)
  }
  return bucket
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
    ownerAddress = uint8ArrayToHex(publicKey as Uint8Array)
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

  const rateLimitRetry = workerRateLimitRetry(params)
  const submit = (identityAddress: string, operation: "add" | "remove") =>
    retryOnRateLimit(
      () =>
        submitPqcTx({
          demos,
          ownerAddress,
          algorithm: params.algorithm,
          identityAddress,
          operation,
          opTimeoutMs: params.cfg.opTimeoutMs,
        }),
      rateLimitRetry,
    )

  while (nowMs() < params.stopAtMs && !params.sharedStop.value) {
    const identityAddress = buildIdentityAddress(params.workerId, sequence++)
    const started = performance.now()
    params.counters.total++
    try {
      await submit(identityAddress, "add")
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

      await submit(identityAddress, "remove")
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
      const bucket = recordStepFailure(params, error, performance.now() - started)
      // A rate-limit error still ends the run here when STOP_ON_RATE_LIMIT is set.
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
      ownerAddress: uint8ArrayToHex(publicKey as Uint8Array),
    })
  }
  return probes
}

/**
 * End-of-run cleanup of one worker: removes each identity it left behind,
 * waits for each remove to show (as the worker's remove step does), then
 * reads which identities are still present. Those are reported as leaked.
 */
export async function cleanupWorkerIdentities(params: {
  report: Pick<WorkerReport, "workerId" | "rpcUrl" | "ownerAddress" | "outstanding">
  cfg: Pick<LoadgenConfig, "algorithm" | "settleTimeoutSec" | "settlePollMs">
  counters: Pick<LoadgenCounters, "cleanupError">
  errorSamples: ErrorSample[]
  removeIdentity: (identityAddress: string) => Promise<void>
  readIdentities?: ReadIdentities
}): Promise<{ ownerAddress: string; stillPresent: string[] }> {
  const { report, cfg } = params
  const readIdentities = params.readIdentities ?? getPqcIdentitySet
  for (const address of report.outstanding) {
    const logContext = {
      workerId: report.workerId,
      rpcUrl: report.rpcUrl,
      ownerAddress: report.ownerAddress,
      identityAddress: address,
    }
    try {
      await params.removeIdentity(address)
    } catch (error) {
      params.counters.cleanupError++
      pushErrorSample(params.errorSamples, "cleanup", error)
      logNonCriticalError("gcr_identity_loadgen.cleanup", error, logContext)
      continue
    }
    // An identity still present after settleTimeoutSec is reported below as leaked.
    await waitForIdentityPresence({
      rpcUrl: report.rpcUrl,
      ownerAddress: report.ownerAddress,
      algorithm: cfg.algorithm,
      identityAddress: address,
      expectPresent: false,
      timeoutSec: cfg.settleTimeoutSec,
      pollMs: cfg.settlePollMs,
      readIdentities,
    }).catch(error => logNonCriticalError("gcr_identity_loadgen.cleanup.settle", error, logContext))
  }

  const existing = await readIdentities(report.rpcUrl, report.ownerAddress, cfg.algorithm)
  const stillPresent = report.outstanding.filter(address => existing.has(normalizeHexAddress(address)))
  return { ownerAddress: report.ownerAddress, stillPresent }
}

/**
 * Runs the timeseries next to the workers: one point a second until stopAtMs,
 * each carrying the counter deltas since the previous point. A worker still
 * waiting for a block at the deadline can count after the loop's last point,
 * so once all workers have settled one final point carries whatever changed
 * since. Summed over the timeseries, each counter a point carries (ok, total,
 * confirmError, broadcastError, validationError, networkError, rateLimited,
 * rateLimitedAtDeadline) equals the summary's total; rateLimitRetries and
 * cleanupError are not in a point.
 */
export async function runWithTimeseries<T>(params: {
  counters: LoadgenCounters
  cfg: Pick<LoadgenConfig, "emitTimeseries">
  stopAtMs: number
  timeseriesSampler: ReservoirSampler
  workers: Promise<T>
  writePoint: (point: TimeseriesPoint) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<T> {
  const { counters, cfg, stopAtMs, timeseriesSampler } = params
  const now = params.now ?? nowMs
  const wait = params.sleep ?? sleep

  let lastPointAtMs = counters.startedAtMs
  let lastOk = 0
  let lastTotal = 0
  let lastConfirm = 0
  let lastBroadcast = 0
  let lastValidation = 0
  let lastNetwork = 0
  let lastRateLimited = 0
  let lastRateLimitedAtDeadline = 0

  const changedSinceLastPoint = () =>
    counters.ok !== lastOk ||
    counters.total !== lastTotal ||
    counters.confirmError !== lastConfirm ||
    counters.broadcastError !== lastBroadcast ||
    counters.validationError !== lastValidation ||
    counters.networkError !== lastNetwork ||
    counters.rateLimited !== lastRateLimited ||
    counters.rateLimitedAtDeadline !== lastRateLimitedAtDeadline

  function writePoint() {
    const pointAtMs = now()
    const elapsedSinceLast = Math.max(0.001, (pointAtMs - lastPointAtMs) / 1000)
    lastPointAtMs = pointAtMs

    const okDelta = counters.ok - lastOk
    const totalDelta = counters.total - lastTotal
    const confirmDelta = counters.confirmError - lastConfirm
    const broadcastDelta = counters.broadcastError - lastBroadcast
    const validationDelta = counters.validationError - lastValidation
    const networkDelta = counters.networkError - lastNetwork
    const rateLimitedDelta = counters.rateLimited - lastRateLimited
    const rateLimitedAtDeadlineDelta = counters.rateLimitedAtDeadline - lastRateLimitedAtDeadline

    lastOk = counters.ok
    lastTotal = counters.total
    lastConfirm = counters.confirmError
    lastBroadcast = counters.broadcastError
    lastValidation = counters.validationError
    lastNetwork = counters.networkError
    lastRateLimited = counters.rateLimited
    lastRateLimitedAtDeadline = counters.rateLimitedAtDeadline

    params.writePoint({
      tSec: (pointAtMs - counters.startedAtMs) / 1000,
      ok: okDelta,
      total: totalDelta,
      confirmError: confirmDelta,
      broadcastError: broadcastDelta,
      validationError: validationDelta,
      networkError: networkDelta,
      rateLimited: rateLimitedDelta,
      rateLimitedAtDeadline: rateLimitedAtDeadlineDelta,
      tps: totalDelta / elapsedSinceLast,
      okTps: okDelta / elapsedSinceLast,
      latencyMs: summarizeLatency(timeseriesSampler.snapshotSorted()),
      timestamp: new Date().toISOString(),
    })
  }

  async function timeseriesLoop() {
    if (!cfg.emitTimeseries) return
    while (now() < stopAtMs) {
      await wait(1000)
      writePoint()
    }
  }

  const timeseriesPromise = timeseriesLoop()
  const result = await params.workers
  await timeseriesPromise
  // Counts made after the loop's last point (e.g. a 429 cut off at the deadline).
  if (cfg.emitTimeseries && changedSinceLastPoint()) writePoint()
  return result
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
    rateLimitedAtDeadline: 0,
    rateLimitRetries: 0,
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

  const sharedStop = { value: false }
  const workers = Array.from({ length: workerCount }, (_, idx) =>
    worker({
      workerId: idx,
      rpcUrl: workerRpcUrl(cfg, idx),
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

  const workerReports = await runWithTimeseries({
    counters,
    cfg,
    stopAtMs,
    timeseriesSampler,
    workers: Promise.all(workers),
    writePoint: point => appendJsonl(artifacts.timeseriesPath, point),
  })
  counters.endedAtMs = nowMs()

  const finalChecks: Array<{ ownerAddress: string; stillPresent: string[] }> = []
  for (const report of workerReports) {
    const removeIdentity = async (address: string) => {
      const demos = new Demos()
      await withTimeout(`cleanup.connect(worker:${report.workerId})`, cfg.opTimeoutMs, demos.connect(report.rpcUrl))
      await withTimeout(
        `cleanup.connectWallet(worker:${report.workerId})`,
        cfg.opTimeoutMs,
        demos.connectWallet(cfg.wallets[report.workerId % cfg.wallets.length]!, { algorithm: "ed25519" }),
      )
      // Cleanup waits out a 429, up to RATE_LIMIT_MAX_RETRIES blocks: leaving the identity behind fails the run.
      await retryOnRateLimit(
        () =>
          submitPqcTx({
            demos,
            ownerAddress: report.ownerAddress,
            algorithm: cfg.algorithm,
            identityAddress: address,
            operation: "remove",
            opTimeoutMs: cfg.opTimeoutMs,
          }),
        rateLimitRetryFor({ rpcUrl: report.rpcUrl, cfg, counters, shouldStop: () => false, stopOnRateLimit: false }),
      )
    }
    finalChecks.push(await cleanupWorkerIdentities({ report, cfg, counters, errorSamples, removeIdentity }))
  }

  const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
  const { errorCount, errorRate } = errorRateOf(counters)
  const leakedIdentities = finalChecks.flatMap(check => check.stillPresent)
  const sampleCodeCounts = errorSamples.reduce<Record<string, number>>((acc, sample) => {
    const key = sample.code ?? "UNKNOWN"
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const { ok, primaryIssues } = runVerdict({
    counters,
    maxErrorRate: cfg.maxErrorRate,
    leakedIdentityCount: leakedIdentities.length,
    sampleCodeCounts,
  })
  const operatorSummary = {
    primaryIssues,
    counterWarnings: [
      counters.rateLimited === 0 && (sampleCodeCounts.RATE_LIMIT ?? 0) > 0
        ? "rate-limit samples were observed even though counters.rateLimited remained 0"
        : null,
    ].filter(Boolean),
    sampleCodeCounts,
  }

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
