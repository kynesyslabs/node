import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import fs from "fs"
import { getRunConfig, writeJson } from "./framework/io"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  pickRecipient,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  sendTokenMintTxWithDemos,
  sendTokenPauseTxWithDemos,
  sendTokenTransferTxWithDemos,
  sendTokenUnpauseTxWithDemos,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
  withDemosWallet,
} from "./token_shared"

type Mode = "pre_pause" | "transition_to_pause" | "paused" | "transition_to_unpause" | "post_unpause"

type PhaseCounters = {
  total: number
  ok: number
  rejectedPaused: number
  rejectedOther: number
  okUnexpected: number
  rejectUnexpected: number
  errorSamples: Record<string, number>
}

type ScenarioCounters = {
  startedAtMs: number
  endedAtMs: number
  perMode: Record<Mode, PhaseCounters>
}

type MempoolDrainReport = {
  ok: boolean
  timeoutSec: number
  pollMs: number
  stablePolls: number
  attempts: number
  durationMs: number
  lastCount: Record<string, number | null>
}

type BlockSkewReport = {
  ok: boolean
  timeoutSec: number
  pollMs: number
  maxSkew: number
  stablePolls: number
  attempts: number
  durationMs: number
  last: Record<string, number | null>
  lastHash: Record<string, string | null>
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

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

async function rpcPost(rpcUrl: string, body: unknown): Promise<any> {
  const url = normalizeRpcUrl(rpcUrl)
  const timeoutMs = envInt("NODECALL_FETCH_TIMEOUT_MS", 8000)
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const json = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, json }
  } catch (error: any) {
    const reason =
      error?.name === "AbortError"
        ? `NODECALL_FETCH_TIMEOUT_MS exceeded (${timeoutMs}ms)`
        : (error instanceof Error ? error.message : String(error))
    return {
      ok: false,
      status: 0,
      json: {
        result: 599,
        response: `rpcPost failed: ${reason}`,
        require_reply: false,
        extra: null,
      },
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function nodeCallExact(rpcUrl: string, message: string, data: any, muid = "loadgen"): Promise<any> {
  const payload = { method: "nodeCall", params: [{ message, data, muid }] }
  const { ok, json } = await rpcPost(rpcUrl, payload)
  if (!ok) return json
  return json
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function ensurePhaseCounters(): PhaseCounters {
  return {
    total: 0,
    ok: 0,
    rejectedPaused: 0,
    rejectedOther: 0,
    okUnexpected: 0,
    rejectUnexpected: 0,
    errorSamples: {},
  }
}

function classifyError(res: any, err: any): string {
  const pieces: string[] = []
  if (typeof err?.message === "string") pieces.push(err.message)
  if (typeof res?.extra?.error === "string") pieces.push(res.extra.error)
  if (typeof res?.response === "string") pieces.push(res.response)
  if (res?.response === false) pieces.push("false")
  if (typeof res?.message === "string") pieces.push(res.message)
  return pieces.join(" ").trim()
}

function isTokenPausedErrorMessage(message: string): boolean {
  return message.toLowerCase().includes("token is paused")
}

function extractMempoolCount(raw: any): number | null {
  const res = raw?.result === 200 ? raw?.response : null
  if (Array.isArray(res)) return res.length
  if (res && typeof res === "object") {
    if (Array.isArray((res as any).txs)) return (res as any).txs.length
    if (Array.isArray((res as any).transactions)) return (res as any).transactions.length
    if (typeof (res as any).size === "number" && Number.isFinite((res as any).size)) return (res as any).size
    if (typeof (res as any).count === "number" && Number.isFinite((res as any).count)) return (res as any).count
  }
  return null
}

async function waitForMempoolDrain(params: {
  rpcUrls: string[]
  timeoutSec: number
  pollMs: number
  stablePolls: number
}): Promise<MempoolDrainReport> {
  const startedAtMs = Date.now()
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))
  const stableNeeded = Math.max(1, Math.floor(params.stablePolls))

  let stable = 0
  let attempts = 0
  let lastCount: Record<string, number | null> = {}

  while (Date.now() < deadlineMs) {
    attempts++
    lastCount = {}
    for (const rpcUrl of params.rpcUrls) {
      const mempool = await nodeCall(rpcUrl, "getMempool", {}, `getMempool:${attempts}:${rpcUrl}`)
      lastCount[rpcUrl] = extractMempoolCount(mempool)
    }

    const counts = Object.values(lastCount)
    const allKnown = counts.every(c => typeof c === "number")
    const allZero = allKnown && counts.every(c => (c ?? 1) === 0)

    if (allZero) {
      stable++
      if (stable >= stableNeeded) {
        return {
          ok: true,
          timeoutSec: params.timeoutSec,
          pollMs,
          stablePolls: stableNeeded,
          attempts,
          durationMs: Date.now() - startedAtMs,
          lastCount,
        }
      }
    } else {
      stable = 0
    }

    await sleep(pollMs)
  }

  return {
    ok: false,
    timeoutSec: params.timeoutSec,
    pollMs,
    stablePolls: stableNeeded,
    attempts,
    durationMs: Date.now() - startedAtMs,
    lastCount,
  }
}

async function getLastBlockNumber(rpcUrl: string, muid: string): Promise<number | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, muid)
  const n = res?.response
  if (typeof n === "number" && Number.isFinite(n)) return n
  if (typeof n === "string") {
    const parsed = Number.parseInt(n, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function getLastBlockHash(rpcUrl: string, muid: string): Promise<string | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockHash", {}, muid)
  const h = res?.response
  if (typeof h === "string" && h.length > 0) return h
  return null
}

async function waitForBlockSkew(params: {
  rpcUrls: string[]
  timeoutSec: number
  pollMs: number
  maxSkew: number
  stablePolls: number
}): Promise<BlockSkewReport> {
  const startedAtMs = Date.now()
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))
  const stableNeeded = Math.max(1, Math.floor(params.stablePolls))
  const maxSkew = Math.max(0, Math.floor(params.maxSkew))

  let stable = 0
  let attempts = 0
  let last: Record<string, number | null> = {}
  let lastHash: Record<string, string | null> = {}

  while (Date.now() < deadlineMs) {
    attempts++
    last = {}
    lastHash = {}
    const values: number[] = []
    for (const rpcUrl of params.rpcUrls) {
      const n = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:skew:${attempts}:${rpcUrl}`)
      last[rpcUrl] = n
      lastHash[rpcUrl] = await getLastBlockHash(rpcUrl, `getLastBlockHash:skew:${attempts}:${rpcUrl}`)
      if (typeof n === "number") values.push(n)
    }

    const min = values.length > 0 ? Math.min(...values) : null
    const max = values.length > 0 ? Math.max(...values) : null
    const skewOk = typeof min === "number" && typeof max === "number" && max - min <= maxSkew

    if (skewOk) {
      stable++
      if (stable >= stableNeeded) {
        return {
          ok: true,
          timeoutSec: params.timeoutSec,
          pollMs,
          maxSkew,
          stablePolls: stableNeeded,
          attempts,
          durationMs: Date.now() - startedAtMs,
          last,
          lastHash,
        }
      }
    } else {
      stable = 0
    }

    await sleep(pollMs)
  }

  return {
    ok: false,
    timeoutSec: params.timeoutSec,
    pollMs,
    maxSkew,
    stablePolls: stableNeeded,
    attempts,
    durationMs: Date.now() - startedAtMs,
    last,
    lastHash,
  }
}

async function waitForCommittedTokenReadReady(params: {
  rpcUrls: string[]
  tokenAddress: string
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))
  let attempts = 0
  let lastPerNode: any[] = []

  while (Date.now() < deadlineMs) {
    attempts++
    lastPerNode = []
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const res = await nodeCall(
        rpcUrl,
        "token.getCommitted",
        { tokenAddress: params.tokenAddress },
        `token.getCommitted:ready:${attempts}:${rpcUrl}`,
      )
      const inFlux = res?.result === 409 && res?.response?.error === "STATE_IN_FLUX"
      const ok = res?.result === 200 && !inFlux
      lastPerNode.push({ rpcUrl, ok, inFlux, raw: res })
      if (!ok) allOk = false
    }
    if (allOk) return { ok: true, attempts, perNode: lastPerNode }
    await sleep(pollMs)
  }

  return { ok: false, attempts, perNode: lastPerNode }
}

async function waitForCrossNodePausedStateLive(params: {
  rpcUrls: string[]
  tokenAddress: string
  expectedPaused: boolean
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))
  let attempts = 0
  let lastPerNode: any[] = []

  while (Date.now() < deadlineMs) {
    attempts++
    lastPerNode = []
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const res = await nodeCallExact(
        rpcUrl,
        "token.get",
        { tokenAddress: params.tokenAddress },
        `token.get:pausedLive:${attempts}:${rpcUrl}`,
      )
      const paused = !!res?.response?.accessControl?.paused
      const ok = res?.result === 200 && paused === params.expectedPaused
      lastPerNode.push({ rpcUrl, ok, paused, raw: res })
      if (!ok) allOk = false
    }
    if (allOk) return { ok: true, attempts, perNode: lastPerNode }
    await sleep(pollMs)
  }

  return { ok: false, attempts, perNode: lastPerNode }
}

async function worker(params: {
  rpcUrl: string
  tokenAddress: string
  walletMnemonic: string
  workerId: number
  recipientAddresses: string[]
  modeRef: { mode: Mode }
  runningRef: { running: boolean }
  counters: ScenarioCounters
  avoidSelfRecipient: boolean
}) {
  const demos = new Demos()
  await waitForRpcReady(params.rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(params.rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(params.rpcUrl)
  await demos.connectWallet(params.walletMnemonic, { algorithm: "ed25519" })

  const sender = (await demos.crypto.getIdentity("ed25519")).publicKey
  const senderHex = normalizeHexAddress(uint8ArrayToHex(sender))

  const to = normalizeHexAddress(
    pickRecipient(params.recipientAddresses, senderHex, params.workerId, params.avoidSelfRecipient),
  )

  // Manage nonce locally, but resync after each attempt (important when we *expect* rejects while paused).
  const startNonce = await demos.getAddressNonce(senderHex)
  let nextNonce = Number(startNonce) + 1

  while (params.runningRef.running) {
    const mode = params.modeRef.mode
    const bucket = (params.counters.perMode[mode] ??= ensurePhaseCounters())
    bucket.total++

    let res: any = null
    let err: any = null
    try {
      const { res: sendRes } = await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress: params.tokenAddress,
        to,
        amount: BigInt(process.env.TOKEN_TRANSFER_AMOUNT ?? "1"),
        nonce: nextNonce,
      })
      res = sendRes
    } catch (e: any) {
      err = e
    }

    const message = classifyError(res, err)
    const isPausedRejection = message ? isTokenPausedErrorMessage(message) : false

    const accepted = res?.result === 200
    if (accepted) {
      bucket.ok++
      if (mode === "paused") bucket.okUnexpected++
    } else {
      if (isPausedRejection) bucket.rejectedPaused++
      else bucket.rejectedOther++
      if (mode === "pre_pause" || mode === "post_unpause") bucket.rejectUnexpected++
    }

    if (!accepted && !isPausedRejection) {
      const key = (message || "unknown").slice(0, 400)
      bucket.errorSamples[key] = (bucket.errorSamples[key] ?? 0) + 1
    }

    // Resync nonce after every attempt. The node typically increments on accept; paused rejects should not.
    try {
      const current = await demos.getAddressNonce(senderHex)
      nextNonce = Number(current) + 1
    } catch {
      // keep old nextNonce and continue; will show up in errorSamples if broken
      nextNonce++
    }
  }
}

function assertRejectedTokenPaused(res: any) {
  if (res?.result === 200) {
    throw new Error(`Expected rejection but got result=200: ${JSON.stringify(res)}`)
  }
  const msg = classifyError(res, null)
  if (!isTokenPausedErrorMessage(msg)) {
    throw new Error(`Expected paused rejection but got: ${JSON.stringify(res)}`)
  }
}

export async function runTokenPauseUnderLoad() {
  maybeSilenceConsole()

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_pause_under_load`

  const targets = getTokenTargets().map(normalizeRpcUrl)
  if (targets.length === 0) throw new Error("No TARGETS configured")

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_pause_under_load requires at least 2 wallets (owner + one sender)")

  const ownerMnemonic = wallets[0]!
  const senderMnemonics = wallets.slice(1)

  const ownerRpc = targets[0]!
  const walletAddresses = (await getWalletAddresses(ownerRpc, wallets)).map(normalizeHexAddress)
  const owner = walletAddresses[0]!

  try {
    const { tokenAddress } = await ensureTokenAndBalances(ownerRpc, ownerMnemonic, walletAddresses)

    const prePauseSec = envInt("PRE_PAUSE_SEC", 20)
    const pausedSec = envInt("PAUSED_SEC", 20)
    const postUnpauseSec = envInt("POST_UNPAUSE_SEC", 20)
    const transitionTimeoutSec = envInt("TRANSITION_TIMEOUT_SEC", 180)
    const transitionPollMs = envInt("TRANSITION_POLL_MS", 500)

    const concurrency = Math.max(
      1,
      Math.min(envInt("CONCURRENCY", senderMnemonics.length || 1), senderMnemonics.length || 1),
    )
    const avoidSelfRecipient = envBool("AVOID_SELF_RECIPIENT", true)

    const modeRef: { mode: Mode } = { mode: "pre_pause" }
    const runningRef = { running: true }
    const counters: ScenarioCounters = {
      startedAtMs: Date.now(),
      endedAtMs: 0,
      perMode: {
        pre_pause: ensurePhaseCounters(),
        transition_to_pause: ensurePhaseCounters(),
        paused: ensurePhaseCounters(),
        transition_to_unpause: ensurePhaseCounters(),
        post_unpause: ensurePhaseCounters(),
      },
    }

    const recipients = walletAddresses

    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) {
      const rpcUrl = targets[i % targets.length]!
      const walletMnemonic = senderMnemonics[i % senderMnemonics.length]!
      workers.push(
        worker({
          rpcUrl,
          tokenAddress,
          walletMnemonic,
          workerId: i,
          recipientAddresses: recipients,
          modeRef,
          runningRef,
          counters,
          avoidSelfRecipient,
        }),
      )
    }

    // Phase 1: run transfers, then pause mid-run.
    await sleep(Math.max(0, prePauseSec) * 1000)
    const pauseTx = await withDemosWallet({
      rpcUrl: ownerRpc,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const from = normalizeHexAddress(fromHex)
        if (from !== owner) throw new Error(`owner identity mismatch: ${from} !== ${owner}`)
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
      },
    })
    if (pauseTx?.res?.result !== 200) {
      runningRef.running = false
      await Promise.allSettled(workers)
      throw new Error(`Pause tx rejected: ${JSON.stringify(pauseTx)}`)
    }

    modeRef.mode = "transition_to_pause"
    const pausedLive = await waitForCrossNodePausedStateLive({
      rpcUrls: targets,
      tokenAddress,
      expectedPaused: true,
      timeoutSec: transitionTimeoutSec,
      pollMs: transitionPollMs,
    })
    if (!pausedLive.ok) {
      runningRef.running = false
      await Promise.allSettled(workers)
      throw new Error(
        `Pause never became visible (token.get) on all nodes. pauseTx=${JSON.stringify(pauseTx)} pausedLive=${JSON.stringify(pausedLive)}`,
      )
    }

    modeRef.mode = "paused"

    // While paused, spot-check explicit transfer/mint/burn rejects from the owner.
    const pausedTransfer = await withDemosWallet({
      rpcUrl: ownerRpc,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const from = normalizeHexAddress(fromHex)
        if (from !== owner) throw new Error(`owner identity mismatch: ${from} !== ${owner}`)
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenTransferTxWithDemos({
          demos,
          tokenAddress,
          to: normalizeHexAddress(walletAddresses[1]!),
          amount: BigInt(process.env.TOKEN_TRANSFER_AMOUNT ?? "1"),
          nonce,
        })
      },
    })
    assertRejectedTokenPaused(pausedTransfer?.res)

    const pausedMint = await withDemosWallet({
      rpcUrl: ownerRpc,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const from = normalizeHexAddress(fromHex)
        if (from !== owner) throw new Error(`owner identity mismatch: ${from} !== ${owner}`)
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenMintTxWithDemos({
          demos,
          tokenAddress,
          to: normalizeHexAddress(walletAddresses[1]!),
          amount: BigInt(process.env.TOKEN_MINT_AMOUNT ?? "1"),
          nonce,
        })
      },
    })
    assertRejectedTokenPaused(pausedMint?.res)

    const pausedBurn = await withDemosWallet({
      rpcUrl: ownerRpc,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const from = normalizeHexAddress(fromHex)
        if (from !== owner) throw new Error(`owner identity mismatch: ${from} !== ${owner}`)
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenBurnTxWithDemos({
          demos,
          tokenAddress,
          from: owner,
          amount: BigInt(process.env.TOKEN_BURN_AMOUNT ?? "1"),
          nonce,
        })
      },
    })
    assertRejectedTokenPaused(pausedBurn?.res)

    await sleep(Math.max(0, pausedSec) * 1000)

    // Unpause mid-run.
    const unpauseTx = await withDemosWallet({
      rpcUrl: ownerRpc,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const from = normalizeHexAddress(fromHex)
        if (from !== owner) throw new Error(`owner identity mismatch: ${from} !== ${owner}`)
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenUnpauseTxWithDemos({ demos, tokenAddress, nonce })
      },
    })
    if (unpauseTx?.res?.result !== 200) {
      runningRef.running = false
      await Promise.allSettled(workers)
      throw new Error(`Unpause tx rejected: ${JSON.stringify(unpauseTx)}`)
    }

    modeRef.mode = "transition_to_unpause"
    const unpausedLive = await waitForCrossNodePausedStateLive({
      rpcUrls: targets,
      tokenAddress,
      expectedPaused: false,
      timeoutSec: transitionTimeoutSec,
      pollMs: transitionPollMs,
    })
    if (!unpausedLive.ok) {
      runningRef.running = false
      await Promise.allSettled(workers)
      throw new Error(
        `Unpause never became visible (token.get) on all nodes. unpauseTx=${JSON.stringify(unpauseTx)} unpausedLive=${JSON.stringify(unpausedLive)}`,
      )
    }

    modeRef.mode = "post_unpause"
    await sleep(Math.max(0, postUnpauseSec) * 1000)

    runningRef.running = false
    await Promise.allSettled(workers)
    counters.endedAtMs = Date.now()

    const mempoolDrain = await waitForMempoolDrain({
      rpcUrls: targets,
      timeoutSec: envInt("MEMPOOL_DRAIN_TIMEOUT_SEC", 180),
      pollMs: envInt("MEMPOOL_DRAIN_POLL_MS", 1000),
      stablePolls: envInt("MEMPOOL_DRAIN_STABLE_POLLS", 3),
    })

    const blockSkew = await waitForBlockSkew({
      rpcUrls: targets,
      timeoutSec: envInt("BLOCK_SKEW_TIMEOUT_SEC", 180),
      pollMs: envInt("BLOCK_SKEW_POLL_MS", 1000),
      maxSkew: envInt("BLOCK_SKEW_MAX", 1),
      stablePolls: envInt("BLOCK_SKEW_STABLE_POLLS", 3),
    })

    const committedReady = await waitForCommittedTokenReadReady({
      rpcUrls: targets,
      tokenAddress,
      timeoutSec: envInt("COMMITTED_READY_TIMEOUT_SEC", 300),
      pollMs: envInt("COMMITTED_READY_POLL_MS", 1000),
    })

    // Final convergence check: committed reads across nodes.
    const crossNodeCommitted = await waitForCrossNodeTokenConsistency({
      rpcUrls: targets,
      tokenAddress,
      addresses: walletAddresses,
      timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 900),
      pollMs: envInt("CROSS_NODE_POLL_MS", 1000),
    })

    const ok =
      pauseTx?.res?.result === 200 &&
      unpauseTx?.res?.result === 200 &&
      counters.perMode.pre_pause.rejectUnexpected === 0 &&
      counters.perMode.post_unpause.rejectUnexpected === 0 &&
      counters.perMode.paused.okUnexpected === 0 &&
      crossNodeCommitted.ok

    const summary = {
      runId: run.runId,
      scenario: "token_pause_under_load",
      tokenAddress,
      rpcUrls: targets,
      owner,
      config: {
        prePauseSec,
        pausedSec,
        postUnpauseSec,
        concurrency,
        avoidSelfRecipient,
        transitionTimeoutSec,
        transitionPollMs,
        crossNodeTimeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 900),
        crossNodePollMs: envInt("CROSS_NODE_POLL_MS", 1000),
      },
      txs: {
        pauseTx,
        unpauseTx,
        pausedTransfer,
        pausedMint,
        pausedBurn,
      },
      liveTransitions: {
        pausedLive,
        unpausedLive,
      },
      settle: {
        mempoolDrain,
        blockSkew,
        committedReady,
      },
      counters: {
        startedAtMs: counters.startedAtMs,
        endedAtMs: counters.endedAtMs,
        durationMs: counters.endedAtMs - counters.startedAtMs,
        perMode: counters.perMode,
      },
      crossNodeCommitted,
      ok,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${artifactBase}.summary.json`, summary)
    console.log(JSON.stringify({ token_pause_under_load_summary: summary }, null, 2))

    if (!ok) {
      throw new Error(`token_pause_under_load failed (see summary): ${artifactBase}.summary.json`)
    }
  } catch (err: any) {
    const summaryPath = `${artifactBase}.summary.json`
    if (!fs.existsSync(summaryPath)) {
      const summary = {
        runId: run.runId,
        scenario: "token_pause_under_load",
        ok: false,
        rpcUrls: targets,
        owner,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }
      writeJson(summaryPath, summary)
      console.log(JSON.stringify({ token_pause_under_load_summary: summary }, null, 2))
    }
    throw err
  }
}
