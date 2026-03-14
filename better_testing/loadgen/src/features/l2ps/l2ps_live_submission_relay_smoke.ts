import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { withDemosWallet } from "../../token_shared"
import {
  collectDbSnapshots,
  getL2psLiveRpcTargets,
  getL2psLiveUid,
  prepareL2psLiveConsole,
  readDockerLogs,
  runCommand,
  seedAddressBalanceAcrossDevnet,
  waitForCondition,
  waitForL2psLiveTargets,
} from "./shared"

function snapshotChanged(before: Awaited<ReturnType<typeof collectDbSnapshots>>, after: Awaited<ReturnType<typeof collectDbSnapshots>>) {
  const node1Advanced = after[0]?.txCount > before[0]?.txCount
  const remoteHashChanged = after.some((entry, index) => {
    if (index === 0) return false
    const baseline = before[index]
    return (
      entry.hash !== baseline?.hash ||
      entry.hashTxCount !== baseline?.hashTxCount ||
      entry.timestamp !== baseline?.timestamp ||
      entry.blockNumber !== baseline?.blockNumber
    )
  })
  const remoteBatchChanged = after.some((entry, index) => {
    if (index === 0) return false
    const baseline = before[index]
    return (
      entry.batchCount > (baseline?.batchCount ?? 0) ||
      entry.batchHash !== baseline?.batchHash ||
      entry.batchBlockNumber !== baseline?.batchBlockNumber
    )
  })
  return {
    node1Advanced,
    remoteHashChanged,
    remoteBatchChanged,
    ok: node1Advanced && remoteBatchChanged,
  }
}

export async function runL2psLiveSubmissionRelaySmoke() {
  prepareL2psLiveConsole()

  const l2psUid = getL2psLiveUid()
  const rpcTargets = getL2psLiveRpcTargets()
  const sourceRpc = rpcTargets[0]!
  const count = Math.max(1, envInt("L2PS_LIVE_SUBMIT_COUNT", 1))
  const value = Math.max(1, envInt("L2PS_LIVE_SEND_VALUE", 1))
  const bootstrapBalance = BigInt(Math.max(value + 1, envInt("L2PS_LIVE_BOOTSTRAP_BALANCE", 25)))
  const timeoutSec = envInt("L2PS_LIVE_RELAY_TIMEOUT_SEC", 45)
  const pollMs = envInt("L2PS_LIVE_RELAY_POLL_MS", 2000)
  const mnemonicFile = process.env.L2PS_LIVE_MNEMONIC_FILE ?? "devnet/identities/node1.identity"
  const keyPath = process.env.L2PS_LIVE_KEY_PATH ?? "devnet/l2ps/live_local_001/private_key.txt"
  const ivPath = process.env.L2PS_LIVE_IV_PATH ?? "devnet/l2ps/live_local_001/iv.txt"
  const startedAt = new Date().toISOString()
  const mnemonic = (await Bun.file(mnemonicFile).text()).trim()

  await waitForL2psLiveTargets(rpcTargets)

  const sourceAddress = await withDemosWallet({
    rpcUrl: sourceRpc,
    mnemonic,
    fn: async (_demos, addressHex) => addressHex,
  })
  await seedAddressBalanceAcrossDevnet(sourceAddress, bootstrapBalance)

  const beforeSnapshots = await collectDbSnapshots(l2psUid)
  const submission = await runCommand([
    "bun",
    "scripts/send-l2-batch.ts",
    "--uid",
    l2psUid,
    "--node",
    sourceRpc.replace(/\/+$/, ""),
    "--key",
    keyPath,
    "--iv",
    ivPath,
    "--mnemonic-file",
    mnemonicFile,
    "--count",
    String(count),
    "--value",
    String(value),
    "--data",
    `l2ps-live-${Date.now()}`,
  ])

  if (!submission.ok) {
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_live_submission_relay_smoke",
      ok: false,
      l2psUid,
      sourceRpc,
      sourceAddress,
      count,
      value,
      bootstrapBalance: bootstrapBalance.toString(),
      startedAt,
      beforeSnapshots,
      submission,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/l2ps/l2ps_live_submission_relay_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_live_submission_relay_smoke_summary: summary }, null, 2))
    throw new Error(`l2ps_live_submission_relay_smoke submission failed: ${submission.stderr || submission.stdout}`)
  }

  const snapshotsWait = await waitForCondition(
    () => collectDbSnapshots(l2psUid),
    (snapshots) => snapshotChanged(beforeSnapshots, snapshots).ok,
    timeoutSec,
    pollMs,
  )

  const relayLogs = await readDockerLogs("node-1", startedAt)
  const relayMatches = (relayLogs.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.includes("Successfully relayed") && line.includes("hash update"))

  const afterSnapshots = snapshotsWait.value
  const changeCheck = snapshotChanged(beforeSnapshots, afterSnapshots)
  const ok = submission.ok && snapshotsWait.ok && changeCheck.ok && relayMatches.length > 0

  const run = getRunConfig()
  const summary = {
    scenario: "l2ps_live_submission_relay_smoke",
    ok,
    l2psUid,
    sourceRpc,
    sourceAddress,
    count,
    value,
    bootstrapBalance: bootstrapBalance.toString(),
    timeoutSec,
    pollMs,
    startedAt,
    beforeSnapshots,
    afterSnapshots,
    snapshotsWait,
    changeCheck,
    submission,
    relayLogExitCode: relayLogs.exitCode,
    relayMatches,
    relayLogTail: relayLogs.stdout.split(/\r?\n/).slice(-40),
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/l2ps/l2ps_live_submission_relay_smoke.summary.json`, summary)
  console.log(JSON.stringify({ l2ps_live_submission_relay_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("l2ps_live_submission_relay_smoke failed: live submission did not produce deterministic relay evidence")
  }
}

if (import.meta.main) {
  await runL2psLiveSubmissionRelaySmoke()
}
