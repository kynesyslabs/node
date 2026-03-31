import { decodeRpcResponse, encodeJsonRequest } from "../../../../../src/libs/omniprotocol/serialization/jsonEnvelope"
import { OmniOpcode } from "../../../../../src/libs/omniprotocol/protocol/opcodes"
import { PeerConnection } from "../../../../../src/libs/omniprotocol/transport/PeerConnection"
import { envInt, normalizeRpcUrl, sleep, splitCsv } from "../../framework/common"
import { nodeCall } from "../../framework/rpc"
import { maybeSilenceConsole, waitForRpcReady, waitForTxReady } from "../../token_shared"

export type L2psLiveDbSnapshot = {
  database: string
  txCount: number
  hash: string | null
  hashTxCount: number | null
  blockNumber: string | null
  timestamp: string | null
  batchCount: number
  batchHash: string | null
  batchBlockNumber: string | null
}

export type L2psLiveCommandResult = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

const defaultLiveTargets = [
  "http://localhost:53551",
  "http://localhost:53553",
  "http://localhost:53555",
  "http://localhost:53557",
]

const defaultDatabases = ["node1_db", "node2_db", "node3_db", "node4_db"]

export function prepareL2psLiveConsole() {
  maybeSilenceConsole()
}

export function getL2psLiveUid(): string {
  return (process.env.L2PS_LIVE_UID ?? "live_local_001").trim()
}

export function getL2psLiveRpcTargets(): string[] {
  const configured = splitCsv(process.env.L2PS_LIVE_TARGETS ?? process.env.TARGETS)
  const values = configured.length > 0 ? configured : defaultLiveTargets
  return values.map(normalizeRpcUrl)
}

export function getL2psLiveOmniTargets(): string[] {
  const protocol = process.env.OMNI_TLS_ENABLED === "true" ? "tls" : "tcp"
  return getL2psLiveRpcTargets().map((rpcUrl) => {
    const url = new URL(rpcUrl)
    const rpcPort = Number.parseInt(url.port, 10) || 80
    return `${protocol}://${url.hostname}:${rpcPort + 10}`
  })
}

export async function waitForL2psLiveTargets(rpcTargets: string[]) {
  const waitForRpcSec = envInt("WAIT_FOR_RPC_SEC", 120)
  const waitForTxSec = envInt("WAIT_FOR_TX_SEC", 120)
  await Promise.all(rpcTargets.map((rpcUrl) => waitForRpcReady(rpcUrl, waitForRpcSec)))
  await Promise.all(rpcTargets.map((rpcUrl) => waitForTxReady(rpcUrl, waitForTxSec)))
}

export async function probeRpcParticipation(rpcUrl: string, l2psUid: string) {
  const participation = await nodeCall(
    rpcUrl,
    "getL2PSParticipationById",
    { l2psUid },
    `l2ps-live:getL2PSParticipationById:${l2psUid}`,
  )
  const mempoolInfo = await nodeCall(
    rpcUrl,
    "getL2PSMempoolInfo",
    { l2psUid },
    `l2ps-live:getL2PSMempoolInfo:${l2psUid}`,
  )

  return {
    rpcUrl,
    participation,
    mempoolInfo,
    ok:
      participation?.result === 200 &&
      participation?.response?.participating === true &&
      mempoolInfo?.result === 200,
  }
}

export async function probeOmniParticipation(omniTarget: string, l2psUid: string) {
  const connection = new PeerConnection(`loadgen:${omniTarget}`, omniTarget)
  try {
    await connection.connect({ timeout: envInt("OMNI_CONNECT_TIMEOUT_MS", 5000) })
    const participationBuffer = await connection.send(
      OmniOpcode.L2PS_GET_PARTICIPATION,
      encodeJsonRequest({ l2psUid }),
      { timeout: envInt("OMNI_REQUEST_TIMEOUT_MS", 5000) },
    )
    const batchStatusBuffer = await connection.send(
      OmniOpcode.L2PS_GET_BATCH_STATUS,
      encodeJsonRequest({ l2psUid }),
      { timeout: envInt("OMNI_REQUEST_TIMEOUT_MS", 5000) },
    )

    const participation = decodeRpcResponse(participationBuffer)
    const batchStatus = decodeRpcResponse(batchStatusBuffer)
    return {
      omniTarget,
      participation,
      batchStatus,
      ok:
        participation?.result === 200 &&
        participation?.response?.participating === true &&
        batchStatus?.result === 200,
    }
  } catch (error) {
    return {
      omniTarget,
      participation: null,
      batchStatus: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await connection.close().catch(() => {})
  }
}

export async function runCommand(cmd: string[], cwd = process.cwd()): Promise<L2psLiveCommandResult> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
  }
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''")
}

export async function queryPostgresDatabase(database: string, l2psUid: string): Promise<L2psLiveDbSnapshot> {
  const sql = [
    "select",
    "coalesce((select count(*)::text from l2ps_transactions where l2ps_uid = '" + escapeSqlString(l2psUid) + "'),'0') || '|' ||",
    "coalesce((select hash from l2ps_hashes where l2ps_uid = '" + escapeSqlString(l2psUid) + "'),'') || '|' ||",
    "coalesce((select transaction_count::text from l2ps_hashes where l2ps_uid = '" + escapeSqlString(l2psUid) + "'),'') || '|' ||",
    "coalesce((select block_number::text from l2ps_hashes where l2ps_uid = '" + escapeSqlString(l2psUid) + "'),'') || '|' ||",
    "coalesce((select timestamp::text from l2ps_hashes where l2ps_uid = '" + escapeSqlString(l2psUid) + "'),'') || '|' ||",
    "coalesce((select count(*)::text from transactions where type = 'l2psBatch' and status = 'confirmed' and content::text like '%" + escapeSqlString(l2psUid) + "%'),'0') || '|' ||",
    "coalesce((select hash from transactions where type = 'l2psBatch' and status = 'confirmed' and content::text like '%" + escapeSqlString(l2psUid) + "%' order by \"blockNumber\" desc, hash desc limit 1),'') || '|' ||",
    "coalesce((select \"blockNumber\"::text from transactions where type = 'l2psBatch' and status = 'confirmed' and content::text like '%" + escapeSqlString(l2psUid) + "%' order by \"blockNumber\" desc, hash desc limit 1),'');",
  ].join(" ")

  const result = await runCommand([
    "docker",
    "compose",
    "-f",
    "testing/devnet/docker-compose.yml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    process.env.POSTGRES_USER ?? "demosuser",
    "-d",
    database,
    "-Atc",
    sql,
  ])

  if (!result.ok) {
    throw new Error(`Failed to query ${database}: ${result.stderr || result.stdout}`)
  }

  const [
    txCountRaw,
    hashRaw,
    hashTxCountRaw,
    blockNumberRaw,
    timestampRaw,
    batchCountRaw,
    batchHashRaw,
    batchBlockNumberRaw,
  ] = result.stdout.trim().split("|")
  return {
    database,
    txCount: Number.parseInt(txCountRaw || "0", 10) || 0,
    hash: hashRaw || null,
    hashTxCount: hashTxCountRaw ? Number.parseInt(hashTxCountRaw, 10) : null,
    blockNumber: blockNumberRaw || null,
    timestamp: timestampRaw || null,
    batchCount: Number.parseInt(batchCountRaw || "0", 10) || 0,
    batchHash: batchHashRaw || null,
    batchBlockNumber: batchBlockNumberRaw || null,
  }
}

export async function updatePostgresAddressBalance(database: string, address: string, balance: bigint): Promise<void> {
  const sql = [
    "update gcr_main",
    "set balance = '" + balance.toString() + "'",
    "where pubkey = '" + escapeSqlString(address) + "';",
  ].join(" ")

  const result = await runCommand([
    "docker",
    "compose",
    "-f",
    "testing/devnet/docker-compose.yml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    process.env.POSTGRES_USER ?? "demosuser",
    "-d",
    database,
    "-Atc",
    sql,
  ])

  if (!result.ok) {
    throw new Error(`Failed to update balance in ${database}: ${result.stderr || result.stdout}`)
  }
}

export async function collectDbSnapshots(l2psUid: string): Promise<L2psLiveDbSnapshot[]> {
  return await Promise.all(defaultDatabases.map((database) => queryPostgresDatabase(database, l2psUid)))
}

export async function seedAddressBalanceAcrossDevnet(address: string, balance: bigint): Promise<void> {
  await Promise.all(defaultDatabases.map((database) => updatePostgresAddressBalance(database, address, balance)))
}

export async function readDockerLogs(service: string, sinceIso: string): Promise<L2psLiveCommandResult> {
  return await runCommand([
    "docker",
    "compose",
    "-f",
    "testing/devnet/docker-compose.yml",
    "logs",
    "--since",
    sinceIso,
    service,
  ])
}

export async function waitForCondition<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutSec: number,
  pollMs: number,
): Promise<{ ok: boolean; attempts: number; value: T }> {
  const deadline = Date.now() + Math.max(1, timeoutSec) * 1000
  let attempts = 0
  let lastValue = await fn()
  attempts++
  while (!predicate(lastValue) && Date.now() < deadline) {
    await sleep(Math.max(50, pollMs))
    lastValue = await fn()
    attempts++
  }
  return {
    ok: predicate(lastValue),
    attempts,
    value: lastValue,
  }
}
