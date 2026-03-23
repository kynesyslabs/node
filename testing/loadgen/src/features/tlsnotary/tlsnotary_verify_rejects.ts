import { maybeSilenceConsole, waitForRpcReady } from "../../token_shared"
import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { fetchTlsNotaryJson, getTlsNotaryTargets, probeTlsNotaryRoutes } from "./shared"

export async function runTlsNotaryVerifyRejects() {
  maybeSilenceConsole()

  const rpcUrls = getTlsNotaryTargets()
  if (rpcUrls.length === 0) throw new Error("tlsnotary_verify_rejects requires at least one RPC target")

  const routeProbes = await Promise.all(
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

  const runnable = routeProbes.filter(probe => probe.reachable && probe.health?.json?.status === "healthy")
  const run = getRunConfig()

  if (runnable.length === 0) {
    const summary = {
      scenario: "tlsnotary_verify_rejects",
      ok: true,
      skipped: true,
      skipReason: "no healthy TLSNotary-enabled RPC targets available",
      rpcUrls,
      probes: routeProbes,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/tlsnotary/tlsnotary_verify_rejects.summary.json`, summary)
    console.log(JSON.stringify({ tlsnotary_verify_rejects_summary: summary }, null, 2))
    return
  }

  const invalidJsonResults = await Promise.all(
    runnable.map(async probe => ({
      rpcUrl: probe.rpcUrl,
      response: await fetchTlsNotaryJson(probe.rpcUrl, "/tlsnotary/verify", {
        method: "POST",
        body: "{invalid",
      }),
    })),
  )
  const missingAttestationResults = await Promise.all(
    runnable.map(async probe => ({
      rpcUrl: probe.rpcUrl,
      response: await fetchTlsNotaryJson(probe.rpcUrl, "/tlsnotary/verify", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    })),
  )
  const placeholderAttestationResults = await Promise.all(
    runnable.map(async probe => ({
      rpcUrl: probe.rpcUrl,
      response: await fetchTlsNotaryJson(probe.rpcUrl, "/tlsnotary/verify", {
        method: "POST",
        body: JSON.stringify({ attestation: "AAAA" }),
      }),
    })),
  )

  const invalidJsonOk = invalidJsonResults.every(entry =>
    entry.response.status === 400 && entry.response.json?.success === false && typeof entry.response.json?.error === "string",
  )
  const missingAttestationOk = missingAttestationResults.every(entry =>
    entry.response.status === 400
      && entry.response.json?.success === false
      && typeof entry.response.json?.error === "string"
      && entry.response.json.error.includes("attestation"),
  )
  const placeholderAttestationOk = placeholderAttestationResults.every(entry =>
    entry.response.status === 400
      && entry.response.json?.success === false
      && typeof entry.response.json?.error === "string",
  )

  const ok = invalidJsonOk && missingAttestationOk && placeholderAttestationOk

  const summary = {
    scenario: "tlsnotary_verify_rejects",
    ok,
    skipped: false,
    rpcUrls,
    runnableRpcUrls: runnable.map(probe => probe.rpcUrl),
    probes: routeProbes,
    invalidJsonResults,
    missingAttestationResults,
    placeholderAttestationResults,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/tlsnotary/tlsnotary_verify_rejects.summary.json`, summary)
  console.log(JSON.stringify({ tlsnotary_verify_rejects_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("tlsnotary_verify_rejects failed: verify route did not reject malformed requests as expected")
  }
}

if (import.meta.main) {
  await runTlsNotaryVerifyRejects()
}
