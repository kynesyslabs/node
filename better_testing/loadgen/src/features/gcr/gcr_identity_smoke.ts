import { getRunConfig, writeJson } from "../../framework/io"
import { envInt, normalizeRpcUrl } from "../../framework/common"
import { pollCrossNodeConvergence } from "../../framework/consistency"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import {
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  readWalletMnemonics,
  waitForRpcReady,
} from "../../token_shared"

type AddressProbe = {
  address: string
  nonceConverged: boolean
  nonceAttempts: number
  noncesByNode: Record<string, number | null>
  infoOkByNode: Record<string, boolean>
}

export async function runGcrIdentitySmoke() {
  maybeSilenceConsole()

  const rpcUrls = getTokenTargets().map(normalizeRpcUrl)
  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("gcr_identity_smoke requires at least 1 wallet")

  const rpcBootstrap = rpcUrls[0]!
  await Promise.all(rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))

  const maxWallets = Math.max(1, envInt("GCR_SMOKE_WALLETS", 3))
  const selectedWallets = wallets.slice(0, maxWallets)
  const addresses = await getWalletAddresses(rpcBootstrap, selectedWallets)

  const timeoutSec = envInt("GCR_CROSS_NODE_TIMEOUT_SEC", 120)
  const pollMs = envInt("GCR_CROSS_NODE_POLL_MS", 500)
  const probes: AddressProbe[] = []

  for (const address of addresses) {
    const nonceConvergence = await pollCrossNodeConvergence<number>({
      rpcUrls,
      timeoutSec,
      pollMs,
      fetcher: async rpcUrl => {
        const res = await nodeCall(rpcUrl, "getAddressNonce", { address }, `gcr:getAddressNonce:${address}`, NO_FALLBACKS)
        const nonceRaw = res?.response
        const nonce =
          typeof nonceRaw === "number"
            ? nonceRaw
            : (typeof nonceRaw === "string" ? Number.parseInt(nonceRaw, 10) : Number.NaN)
        if (res?.result === 200 && Number.isFinite(nonce)) {
          return { rpcUrl, ok: true, value: nonce, error: null }
        }
        return { rpcUrl, ok: false, value: null, error: res }
      },
      equals: (a, b) => a === b,
    })

    const noncesByNode: Record<string, number | null> = {}
    const infoOkByNode: Record<string, boolean> = {}

    for (const rpcUrl of rpcUrls) {
      const nonceRes = await nodeCall(rpcUrl, "getAddressNonce", { address }, `gcr:getAddressNonce:final:${address}`, NO_FALLBACKS)
      const nonceRaw = nonceRes?.response
      const nonce =
        typeof nonceRaw === "number"
          ? nonceRaw
          : (typeof nonceRaw === "string" ? Number.parseInt(nonceRaw, 10) : Number.NaN)
      noncesByNode[rpcUrl] = Number.isFinite(nonce) ? nonce : null

      const infoRes = await nodeCall(rpcUrl, "getAddressInfo", { address }, `gcr:getAddressInfo:${address}`, NO_FALLBACKS)
      infoOkByNode[rpcUrl] = infoRes?.result === 200 && !!infoRes?.response
    }

    probes.push({
      address,
      nonceConverged: nonceConvergence.ok,
      nonceAttempts: nonceConvergence.attempts,
      noncesByNode,
      infoOkByNode,
    })
  }

  const allNonceConverged = probes.every(p => p.nonceConverged)
  const allInfoOk = probes.every(p => Object.values(p.infoOkByNode).every(Boolean))
  const ok = allNonceConverged && allInfoOk

  const run = getRunConfig()
  const summary = {
    scenario: "gcr_identity_smoke",
    ok,
    rpcUrls,
    walletCount: selectedWallets.length,
    timeoutSec,
    pollMs,
    probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/gcr/gcr_identity_smoke.summary.json`, summary)
  console.log(JSON.stringify({ gcr_identity_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("gcr_identity_smoke failed: nonce or identity state did not converge")
  }
}

if (import.meta.main) {
  await runGcrIdentitySmoke()
}
