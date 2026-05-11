#!/usr/bin/env bun

import { envInt, normalizeRpcUrl, splitCsv } from "../loadgen/src/framework/common"
import { rpcPost } from "../loadgen/src/framework/rpc"
import { nodeCall, NO_FALLBACKS } from "../loadgen/src/framework/rpc"
import { httpRpcToOmni } from "../loadgen/src/features/omni/shared"
import { decodePeerlistResponse } from "../../src/libs/omniprotocol/serialization/control"
import { OmniOpcode } from "../../src/libs/omniprotocol/protocol/opcodes"
import { PeerConnection } from "../../src/libs/omniprotocol/transport/PeerConnection"

const defaultRpcTargets = [
  "http://localhost:53551",
  "http://localhost:53553",
  "http://localhost:53555",
  "http://localhost:53557",
]

const outputJson = process.argv.includes("--json")
const verbose = process.argv.includes("--verbose")

function getRpcTargets(): string[] {
  const explicit = splitCsv(process.env.TARGETS)
  const targets = explicit.length > 0 ? explicit : defaultRpcTargets
  return targets.map(normalizeRpcUrl)
}

type RpcProbe = {
  rpcUrl: string
  pingOk: boolean
  txReady: boolean
  blockNumber: number | null
  error: string | null
}

type OmniProbe = {
  target: string
  ok: boolean
  status: number | null
  peerCount: number
  error: string | null
}

async function probeRpc(rpcUrl: string): Promise<RpcProbe> {
  try {
    const ping = await rpcPost(rpcUrl, { method: "ping", params: [] })
    const hash = await nodeCall(rpcUrl, "getLastBlockHash", {}, "doctor:getLastBlockHash", NO_FALLBACKS)
    const numberRes = await nodeCall(rpcUrl, "getLastBlockNumber", {}, "doctor:getLastBlockNumber", NO_FALLBACKS)
    const blockNumber = typeof numberRes?.response === "number"
      ? numberRes.response
      : typeof numberRes?.response === "string"
        ? Number.parseInt(numberRes.response, 10)
        : null
    const pingOk = ping.ok && ping.json?.result === 200
    const txReady = hash?.result === 200 && typeof hash?.response === "string" && hash.response.length > 0

    const res = {
      rpcUrl,
      pingOk,
      txReady,
      blockNumber: Number.isFinite(blockNumber as number) ? blockNumber : null,
      error: pingOk && txReady ? null : JSON.stringify({ ping: ping.json, getLastBlockHash: hash, getLastBlockNumber: numberRes }),
    }
    console.log(res)
    return res
  } catch (error) {
    console.error(error)
    return {
      rpcUrl,
      pingOk: false,
      txReady: false,
      blockNumber: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function probeOmni(target: string): Promise<OmniProbe> {
  const connection = new PeerConnection(`doctor:${target}`, target)
  try {
    await connection.connect({ timeout: envInt("OMNI_CONNECT_TIMEOUT_MS", 3000) })
    const response = await connection.send(OmniOpcode.GET_PEERLIST, Buffer.alloc(0), { timeout: envInt("OMNI_REQUEST_TIMEOUT_MS", 3000) })
    const decoded = decodePeerlistResponse(response)
    return {
      target,
      ok: decoded.status === 200,
      status: decoded.status,
      peerCount: decoded.peers.length,
      error: null,
    }
  } catch (error) {
    return {
      target,
      ok: false,
      status: null,
      peerCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await connection.close().catch(() => {})
  }
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(",") : "<none>"
}

function printHumanSummary(summary: any) {
  console.log("Test Environment Doctor")
  console.log(`Timestamp: ${summary.timestamp}`)
  console.log(`RPC healthy: ${summary.rpc.healthyRpcUrls.length}/${summary.rpc.targets.length}`)
  console.log(`RPC healthy targets: ${formatList(summary.rpc.healthyRpcUrls)}`)
  console.log(`RPC unhealthy targets: ${formatList(summary.rpc.unhealthyRpcUrls)}`)
  console.log(`Omni healthy: ${summary.omni.healthyOmniTargets.length}/${summary.omni.targets.length}`)
  console.log(`Omni healthy targets: ${formatList(summary.omni.healthyOmniTargets)}`)
  console.log("Recommended commands:")
  console.log(`  sanity        ${summary.recommended.sanity}`)
  console.log(`  clusterHealth ${summary.recommended.clusterHealth}`)
  console.log(`  gcrFocus      ${summary.recommended.gcrFocus}`)
  if (!verbose) {
    console.log("Hint: rerun with --verbose for Omni transport debug output.")
  }
}

async function main() {
  const rpcTargets = getRpcTargets()
  const rpcProbes = await Promise.all(rpcTargets.map(probeRpc))
  const healthyRpcUrls = rpcProbes.filter(item => item.pingOk && item.txReady).map(item => item.rpcUrl)
  const unhealthyRpcUrls = rpcProbes.filter(item => !(item.pingOk && item.txReady)).map(item => item.rpcUrl)
  const omniTargets = rpcTargets.map(httpRpcToOmni)
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  if (!verbose) {
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
  }
  const omniProbes = await Promise.all(omniTargets.map(probeOmni))
  if (!verbose) {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
  const healthyOmniTargets = omniProbes.filter(item => item.ok).map(item => item.target)

  const recommended = {
    sanity: "bun run testenv:sanity:local",
    clusterHealth: healthyRpcUrls.length >= 2
      ? "bun run testenv:cluster:local"
      : "cluster-health unavailable: fewer than 2 healthy RPC targets",
    gcrFocus: healthyRpcUrls.length >= 1
      ? "bun run testenv:gcr:local"
      : "gcr-focus unavailable: no healthy RPC targets",
  }

  const summary = {
    timestamp: new Date().toISOString(),
    rpc: {
      targets: rpcTargets,
      healthyRpcUrls,
      unhealthyRpcUrls,
      probes: rpcProbes,
    },
    omni: {
      targets: omniTargets,
      healthyOmniTargets,
      unhealthyOmniTargets: omniProbes.filter(item => !item.ok).map(item => item.target),
      probes: omniProbes,
    },
    recommended,
  }

  if (outputJson) {
    console.log(JSON.stringify({ testenv_doctor: summary }, null, 2))
    return
  }

  printHumanSummary(summary)
}

await main()
