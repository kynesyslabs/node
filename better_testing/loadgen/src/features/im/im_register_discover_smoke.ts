import { getRunConfig, writeJson } from "../../framework/io"
import { envInt } from "../../framework/common"
import { generateClientId, getImFeatureTargets, maybeSilenceConsole, registerClient, waitForJsonMessage } from "./shared"

export async function runImRegisterDiscoverSmoke() {
  maybeSilenceConsole()

  const wsTargets = getImFeatureTargets()
  if (wsTargets.length === 0) {
    throw new Error("im_register_discover_smoke requires at least one signaling target")
  }

  const timeoutMs = envInt("IM_MESSAGE_TIMEOUT_MS", 10000)
  const probes = await Promise.all(wsTargets.map(async wsUrl => {
    const clientId = generateClientId()
    let client: Awaited<ReturnType<typeof registerClient>> | null = null
    try {
      client = await registerClient({
        wsUrl,
        clientId,
        instanceId: `im-smoke:${clientId}`,
        timeoutSec: Math.ceil(timeoutMs / 1000),
      })

      const discoverPromise = waitForJsonMessage(
        client.ws,
        message => message?.type === "discover" && Array.isArray(message?.payload?.peers),
        timeoutMs,
      )
      client.sendRaw({ type: "discover", payload: {} })
      const discover = await discoverPromise
      const peers = Array.isArray(discover?.payload?.peers) ? discover.payload.peers : []

      return {
        wsUrl,
        ok: peers.includes(clientId),
        clientId,
        peers,
        error: null,
      }
    } catch (error) {
      return {
        wsUrl,
        ok: false,
        clientId,
        peers: [],
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      client?.close()
    }
  }))

  const ok = probes.length > 0 && probes.every(probe => probe.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "im_register_discover_smoke",
    ok,
    wsTargets,
    probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/im/im_register_discover_smoke.summary.json`, summary)
  console.log(JSON.stringify({ im_register_discover_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("im_register_discover_smoke failed: register/discover flow did not return the expected peer list")
  }
}

if (import.meta.main) {
  await runImRegisterDiscoverSmoke()
}
