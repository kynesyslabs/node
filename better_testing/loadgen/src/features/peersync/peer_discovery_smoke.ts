import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole } from "../../token_shared"
import { getClusterObservation, getPeerSyncTargets, waitForPeerSyncTargets } from "./shared"

export async function runPeerDiscoverySmoke() {
  maybeSilenceConsole()

  const rpcUrls = getPeerSyncTargets()
  if (rpcUrls.length === 0) throw new Error("peer_discovery_smoke requires at least one RPC target")
  await waitForPeerSyncTargets(rpcUrls, false)

  const observation = await getClusterObservation(rpcUrls)
  const run = getRunConfig()

  if (observation.healthyNodeCount < 2) {
    const summary = {
      scenario: "peer_discovery_smoke",
      ok: true,
      skipped: true,
      skipReason: "need at least 2 healthy RPC targets to validate peer discovery",
      rpcUrls,
      observation,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/peersync/peer_discovery_smoke.summary.json`, summary)
    console.log(JSON.stringify({ peer_discovery_smoke_summary: summary }, null, 2))
    return
  }

  const minPeers = Math.max(1, envInt("PEER_DISCOVERY_MIN_PEERS", observation.healthyNodeCount))
  const perNode = Object.fromEntries(
    observation.healthyRpcUrls.map(rpcUrl => {
      const snapshot = observation.byNode[rpcUrl]!
      const missingKnownIdentities = observation.knownNodeIdentities.filter(identity => !snapshot.peerIdentities.includes(identity))
      return [rpcUrl, {
        ok: snapshot.peerCount >= minPeers && snapshot.selfInPeerlist && missingKnownIdentities.length === 0,
        peerCount: snapshot.peerCount,
        minPeers,
        selfInPeerlist: snapshot.selfInPeerlist,
        missingKnownIdentities,
      }]
    }),
  )

  const ok = observation.peerDiscoveryComplete && Object.values(perNode).every((entry: any) => entry.ok)
  const summary = {
    scenario: "peer_discovery_smoke",
    ok,
    skipped: false,
    rpcUrls,
    minPeers,
    knownNodeIdentities: observation.knownNodeIdentities,
    observation,
    perNode,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/peersync/peer_discovery_smoke.summary.json`, summary)
  console.log(JSON.stringify({ peer_discovery_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("peer_discovery_smoke failed: healthy nodes do not agree on the discovered peer set")
  }
}

if (import.meta.main) {
  await runPeerDiscoverySmoke()
}
