import { getRunConfig, writeJson } from "../../framework/io"
import {
  getL2psLiveOmniTargets,
  getL2psLiveRpcTargets,
  getL2psLiveUid,
  prepareL2psLiveConsole,
  probeOmniParticipation,
  probeRpcParticipation,
  waitForL2psLiveTargets,
} from "./shared"

export async function runL2psLiveParticipationSmoke() {
  prepareL2psLiveConsole()

  const l2psUid = getL2psLiveUid()
  const rpcTargets = getL2psLiveRpcTargets()
  const omniTargets = getL2psLiveOmniTargets()

  await waitForL2psLiveTargets(rpcTargets)

  let rpcProbes = await Promise.all(rpcTargets.map((rpcUrl) => probeRpcParticipation(rpcUrl, l2psUid)))
  let omniProbes = await Promise.all(omniTargets.map((omniTarget) => probeOmniParticipation(omniTarget, l2psUid)))

  const deadline = Date.now() + 30_000
  while (
    Date.now() < deadline &&
    !(rpcProbes.every((probe) => probe.ok) && omniProbes.every((probe) => probe.ok))
  ) {
    await Bun.sleep(2_000)
    rpcProbes = await Promise.all(rpcTargets.map((rpcUrl) => probeRpcParticipation(rpcUrl, l2psUid)))
    omniProbes = await Promise.all(omniTargets.map((omniTarget) => probeOmniParticipation(omniTarget, l2psUid)))
  }

  const ok = rpcProbes.every((probe) => probe.ok) && omniProbes.every((probe) => probe.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "l2ps_live_participation_smoke",
    ok,
    l2psUid,
    rpcTargets,
    omniTargets,
    rpcProbes,
    omniProbes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/l2ps/l2ps_live_participation_smoke.summary.json`, summary)
  console.log(JSON.stringify({ l2ps_live_participation_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("l2ps_live_participation_smoke failed: one or more live L2PS targets were not participating")
  }
}

if (import.meta.main) {
  await runL2psLiveParticipationSmoke()
}
