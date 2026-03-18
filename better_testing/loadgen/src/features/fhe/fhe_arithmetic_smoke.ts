import { getRunConfig, writeJson } from "../../framework/io"
import { getReadyFhe } from "./shared"

export async function runFheArithmeticSmoke() {
  const plainValue = Number.parseInt(process.env.FHE_PLAIN_VALUE ?? "7", 10)
  const addStep = Number.parseInt(process.env.FHE_ADD_STEP ?? "5", 10)
  const multiplyStep = Number.parseInt(process.env.FHE_MULTIPLY_STEP ?? "3", 10)

  const fhe = await getReadyFhe()

  const baseCipher = await fhe.encryption.encryptNumber(plainValue)
  const addCipher = await fhe.encryption.encryptNumber(addStep)
  const addResultCipher = await fhe.math.addNumbers(baseCipher, addCipher)
  const additionResult = await fhe.encryption.decryptNumber(addResultCipher)

  const multiplyCipher = await fhe.encryption.encryptNumber(multiplyStep)
  const multiplyResultCipher = await fhe.math.multiplyNumbers(baseCipher, multiplyCipher)
  const multiplicationResult = await fhe.encryption.decryptNumber(multiplyResultCipher)

  const negateResultCipher = await fhe.math.negate(baseCipher)
  const negateResult = await fhe.encryption.decryptNumber(negateResultCipher)

  const expectedAddition = plainValue + addStep
  const expectedMultiplication = expectedAddition * multiplyStep
  const expectedNegation = -expectedMultiplication
  const ok = (
    additionResult === expectedAddition
    && multiplicationResult === expectedMultiplication
    && negateResult === expectedNegation
  )

  const run = getRunConfig()
  const summary = {
    scenario: "fhe_arithmetic_smoke",
    ok,
    plainValue,
    addStep,
    multiplyStep,
    additionResult,
    multiplicationResult,
    negateResult,
    expectedAddition,
    expectedMultiplication,
    expectedNegation,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/fhe/fhe_arithmetic_smoke.summary.json`, summary)
  console.log(JSON.stringify({ fhe_arithmetic_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("fhe_arithmetic_smoke failed: encrypted arithmetic results did not match plaintext expectations")
  }
}

if (import.meta.main) {
  await runFheArithmeticSmoke()
}
