import { Demos } from "@kynesyslabs/demosdk/websdk"
import { Cryptography, Hashing, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

type ProbeResult = {
  label: string
  identity: string
  txFrom: string
  txFromEd25519Address: string
  signature: string
}

function usage(): never {
  console.error(
    "Usage: bun scripts/repro-demosdk-multi-instance-identity-bleed.ts [rpcUrl] [walletA] [walletB]",
  )
  process.exit(1)
}

async function readMnemonic(path: string): Promise<string> {
  return (await Bun.file(path).text()).trim()
}

function defaultArgs() {
  const rpcUrl = process.argv[2] ?? "http://localhost:53554"
  const walletA = process.argv[3] ?? "devnet/identities/node1.identity"
  const walletB = process.argv[4] ?? "devnet/identities/node2.identity"
  return { rpcUrl, walletA, walletB }
}

async function buildProbe(demos: Demos, label: string): Promise<ProbeResult> {
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const identity = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = identity
  tx.content.amount = 0
  tx.content.nonce = 1
  tx.content.timestamp = Date.now()
  tx.content.data = [label, { label }]
  tx.content.from = identity
  tx.content.from_ed25519_address = identity
  tx.hash = Hashing.sha256(JSON.stringify(tx.content))

  const signatureBytes = Cryptography.sign(tx.hash, (demos as any).keypair.privateKey)
  tx.signature = { type: "ed25519", data: uint8ArrayToHex(signatureBytes) }

  return {
    label,
    identity,
    txFrom: tx.content.from,
    txFromEd25519Address: tx.content.from_ed25519_address,
    signature: tx.signature.data,
  }
}

function printSection(title: string, payload: unknown) {
  console.log(`\n## ${title}`)
  console.log(JSON.stringify(payload, null, 2))
}

function assertDistinct(stage: string, left: ProbeResult, right: ProbeResult) {
  if (left.identity === right.identity) {
    throw new Error(`${stage}: both Demos instances resolved to the same identity ${left.identity}`)
  }
}

async function main() {
  const { rpcUrl, walletA, walletB } = defaultArgs()
  if (!rpcUrl || !walletA || !walletB) usage()

  const [mnemonicA, mnemonicB] = await Promise.all([readMnemonic(walletA), readMnemonic(walletB)])
  const demosA = new Demos()
  const demosB = new Demos()

  await Promise.all([demosA.connect(rpcUrl), demosB.connect(rpcUrl)])

  await demosA.connectWallet(mnemonicA, { algorithm: "ed25519" })
  const sequentialA = await buildProbe(demosA, "sequential-a")

  await demosB.connectWallet(mnemonicB, { algorithm: "ed25519" })
  const sequentialB = await buildProbe(demosB, "sequential-b")

  printSection("sequential", { sequentialA, sequentialB })

  const concurrent = await Promise.all([
    (async () => {
      await demosA.connectWallet(mnemonicA, { algorithm: "ed25519" })
      return buildProbe(demosA, "concurrent-a")
    })(),
    (async () => {
      await demosB.connectWallet(mnemonicB, { algorithm: "ed25519" })
      return buildProbe(demosB, "concurrent-b")
    })(),
  ])

  printSection("concurrent", { concurrentA: concurrent[0], concurrentB: concurrent[1] })

  assertDistinct("sequential", sequentialA, sequentialB)
  assertDistinct("concurrent", concurrent[0], concurrent[1])

  console.log("\nRepro did not trigger; identities remained distinct.")
}

main().catch((err) => {
  console.error("\nRepro triggered:")
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(2)
})
