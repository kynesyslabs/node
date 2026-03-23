import FHE from "../../../../../src/features/fhe/FHE"

let fheReady = false

export async function getReadyFhe(): Promise<FHE> {
  const fhe = await FHE.getInstance()
  if (!fheReady) {
    await fhe.config.setParameters()
    await fhe.config.createKeysAndEncoders()
    fheReady = true
  }
  return fhe
}
