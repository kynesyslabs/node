import { getRunConfig, writeJson } from "../../framework/io"
import ParallelNetworks from "../../../../../src/libs/l2ps/parallelNetworks"

export async function runL2psRegistryStateSmoke() {
  const parallelNetworks = ParallelNetworks.getInstance() as any

  const previousConfigs = parallelNetworks.configs
  const previousL2pses = parallelNetworks.l2pses
  const previousLoadL2PS = parallelNetworks.loadL2PS

  parallelNetworks.configs = new Map([
    ["uid-1", { uid: "uid-1", name: "alpha", enabled: true }],
    ["uid-2", { uid: "uid-2", name: "beta", enabled: false }],
  ])
  parallelNetworks.l2pses = new Map([
    ["uid-1", { sentinel: "loaded-alpha" }],
  ])

  try {
    parallelNetworks.loadL2PS = async (uid: string) => {
      if (uid === "uid-1") {
        return parallelNetworks.l2pses.get(uid)
      }
      throw new Error("missing l2ps")
    }

    const ids = parallelNetworks.getAllL2PSIds().sort()
    const loaded = await parallelNetworks.getL2PS("uid-1")
    const missing = await parallelNetworks.getL2PS("uid-404")

    const checks = {
      allIdsReflectLoadedMap: JSON.stringify(ids) === JSON.stringify(["uid-1"]),
      configLookupWorks: parallelNetworks.getL2PSConfig("uid-2")?.name === "beta",
      loadedFlagWorks: parallelNetworks.isL2PSLoaded("uid-1") === true && parallelNetworks.isL2PSLoaded("uid-2") === false,
      getL2PSSuccessPath: loaded?.sentinel === "loaded-alpha",
      getL2PSFailurePath: missing === undefined,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_registry_state_smoke",
      ok,
      checks,
      ids,
      loaded,
      missing,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_registry_state_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_registry_state_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_registry_state_smoke failed: registry state behavior did not match expectations")
    }
  } finally {
    parallelNetworks.configs = previousConfigs
    parallelNetworks.l2pses = previousL2pses
    parallelNetworks.loadL2PS = previousLoadL2PS
  }
}

if (import.meta.main) {
  await runL2psRegistryStateSmoke()
}
