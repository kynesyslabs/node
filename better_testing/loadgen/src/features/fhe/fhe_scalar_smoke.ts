import { getRunConfig, writeJson } from "../../framework/io"
import { getReadyFhe } from "./shared"

export async function runFheScalarSmoke() {
  const plainValue = Number.parseInt(process.env.FHE_PLAIN_VALUE ?? "7", 10)
  const fhe = await getReadyFhe()

  const cipherText = await fhe.encryption.encryptNumber(plainValue)
  const decryptedValue = await fhe.encryption.decryptNumber(cipherText)
  const ok = decryptedValue === plainValue

  const run = getRunConfig()
  const summary = {
    scenario: "fhe_scalar_smoke",
    ok,
    plainValue,
    decryptedValue,
    contextReady: Boolean(fhe.context?.parametersSet?.()),
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/fhe/fhe_scalar_smoke.summary.json`, summary)
  console.log(JSON.stringify({ fhe_scalar_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error(`fhe_scalar_smoke failed: decrypted ${decryptedValue} != plain ${plainValue}`)
  }
}

if (import.meta.main) {
  await runFheScalarSmoke()
}
