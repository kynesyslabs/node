import { maybeSilenceConsole, waitForRpcReady } from "../../token_shared"
import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { getTlsNotaryTargets, probeTlsNotaryRoutes } from "./shared"

export async function runTlsNotaryRoutesSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getTlsNotaryTargets()
  if (rpcUrls.length === 0) throw new Error("tlsnotary_routes_smoke requires at least one RPC target")

  const probes = await Promise.all(
    rpcUrls.map(async rpcUrl => {
      try {
        await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 30))
        return await probeTlsNotaryRoutes(rpcUrl)
      } catch (error) {
        return {
          rpcUrl,
          reachable: false,
          health: null,
          info: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )

  const reachable = probes.filter(probe => probe.reachable)
  const allDisabled = reachable.length > 0 && reachable.every(probe => {
    const healthBody = probe.health?.json
    const infoBody = probe.info?.json
    return probe.health?.status === 200
      && healthBody?.status === "disabled"
      && probe.info?.status === 200
      && infoBody?.enabled === false
  })

  const ok = reachable.length > 0 && reachable.every(probe => {
    const healthBody = probe.health?.json
    const infoBody = probe.info?.json
    if (!probe.health || !probe.info || !healthBody || !infoBody) return false
    if (healthBody.status === "disabled") {
      return probe.health.status === 200 && infoBody.enabled === false
    }
    if (healthBody.status === "healthy") {
      return probe.health.status === 200
        && infoBody.enabled === true
        && typeof infoBody.port === "number"
        && infoBody.port > 0
    }
    return false
  })

  const run = getRunConfig()
  const summary = {
    scenario: "tlsnotary_routes_smoke",
    ok,
    skipped: false,
    allDisabled,
    rpcUrls,
    reachableRpcUrls: reachable.map(probe => probe.rpcUrl),
    unreachableRpcUrls: probes.filter(probe => !probe.reachable).map(probe => probe.rpcUrl),
    probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/tlsnotary/tlsnotary_routes_smoke.summary.json`, summary)
  console.log(JSON.stringify({ tlsnotary_routes_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("tlsnotary_routes_smoke failed: health/info routes did not return expected disabled or healthy semantics")
  }
}

if (import.meta.main) {
  await runTlsNotaryRoutesSmoke()
}
