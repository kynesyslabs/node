import { Demos } from "@kynesyslabs/demosdk/websdk"
import { Cryptography, Hashing, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { envBool, envInt, logNonCriticalErrorOnce, normalizeHexAddress, normalizeRpcUrl, nowMs, sleep, splitCsv } from "./framework/common"
import {
  type CrossNodeHolderPointersReport,
  type CrossNodeTokenConsistencyReport,
  type CrossNodeTokenGetConsistencyReport,
  normalizeTokenPointerEntry,
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  waitForCrossNodeTokenGetConsistency,
} from "./framework/consistency"
import { nodeCall, nodeCallExact } from "./framework/rpc"

export { nodeCall, nodeCallExact } from "./framework/rpc"
export {
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  waitForCrossNodeTokenGetConsistency,
} from "./framework/consistency"
export type {
  CrossNodeHolderPointersReport,
  CrossNodeTokenConsistencyReport,
  CrossNodeTokenGetConsistencyReport,
} from "./framework/consistency"

async function waitForTokenExists(rpcUrl: string, tokenAddress: string, timeoutSec: number): Promise<void> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  let last: any = null
  while (nowMs() < deadlineMs) {
    const res = await nodeCall(rpcUrl, "token.getCommitted", { tokenAddress }, `token.getCommitted:${attempt}`)
    last = res
    if (res?.result === 200 && res?.response?.tokenAddress) return
    const live = await nodeCallExact(rpcUrl, "token.get", { tokenAddress }, `token.get:liveFallback:${attempt}`)
    last = live
    if (live?.result === 200 && live?.response?.tokenAddress) return
    attempt++
    const backoffMs = Math.min(2000, 100 + attempt * 100)
    await sleep(backoffMs)
  }
  throw new Error(
    `Token not visible via nodeCall token.getCommitted (or token.get fallback) after ${timeoutSec}s: ${tokenAddress}. Last=${JSON.stringify(last)}`,
  )
}

async function waitForTokenBalanceAtLeast(
  rpcUrl: string,
  tokenAddress: string,
  address: string,
  minBalance: bigint,
  timeoutSec: number,
): Promise<void> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  while (nowMs() < deadlineMs) {
    const res = await nodeCall(rpcUrl, "token.getBalanceCommitted", { tokenAddress, address }, `token.getBalanceCommitted:${attempt}`)
    const balRaw = res?.response?.balance
    if (typeof balRaw === "string") {
      try {
        const bal = BigInt(balRaw)
        if (bal >= minBalance) return
      } catch (error) {
        logNonCriticalErrorOnce("token_shared.waitForTokenBalanceAtLeast.committed", "token_shared.waitForTokenBalanceAtLeast.committed", error, {
          rpcUrl,
          tokenAddress,
          address,
          balance: balRaw,
        })
      }
    }
    const live = await nodeCallExact(rpcUrl, "token.getBalance", { tokenAddress, address }, `token.getBalance:liveFallback:${attempt}`)
    const liveBalRaw = live?.response?.balance
    if (typeof liveBalRaw === "string") {
      try {
        const bal = BigInt(liveBalRaw)
        if (bal >= minBalance) return
      } catch (error) {
        logNonCriticalErrorOnce("token_shared.waitForTokenBalanceAtLeast.live", "token_shared.waitForTokenBalanceAtLeast.live", error, {
          rpcUrl,
          tokenAddress,
          address,
          balance: liveBalRaw,
        })
      }
    }
    attempt++
    const backoffMs = Math.min(2000, 100 + attempt * 100)
    await sleep(backoffMs)
  }
  throw new Error(`Token balance did not reach ${minBalance.toString()} for ${address} after ${timeoutSec}s`)
}

export async function waitForTxReady(rpcUrl: string, timeoutSec: number): Promise<void> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  while (nowMs() < deadlineMs) {
    const res = await nodeCall(rpcUrl, "getLastBlockHash", {}, `getLastBlockHash:txReady:${attempt}`)
    if (res?.result === 200 && typeof res?.response === "string" && res.response.length > 0) return
    attempt++
    const backoffMs = Math.min(2000, 100 + attempt * 100)
    await sleep(backoffMs)
  }
  throw new Error(`Tx pipeline not ready (getLastBlockHash) after ${timeoutSec}s at ${rpcUrl}`)
}

async function waitForChainReady(rpcUrl: string, timeoutSec: number): Promise<void> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  while (nowMs() < deadlineMs) {
    const res = await nodeCall(rpcUrl, "getLastBlockHash", {}, `getLastBlockHash:${attempt}`)
    if (res?.result === 200 && typeof res?.response === "string" && res.response.length > 0) return
    attempt++
    const backoffMs = Math.min(2000, 100 + attempt * 100)
    await sleep(backoffMs)
  }
  throw new Error(`Chain not ready (getLastBlockHash) after ${timeoutSec}s at ${rpcUrl}`)
}

async function isRpcReady(rpcUrl: string): Promise<boolean> {
  const url = normalizeRpcUrl(rpcUrl)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "ping", params: [] }),
    })
    if (!res.ok) return false
    const data = (await res.json().catch(() => null)) as any
    return typeof data?.result === "number" && data.result >= 200 && data.result < 300
  } catch (error) {
    logNonCriticalErrorOnce(`token_shared.isRpcReady:${url}`, "token_shared.isRpcReady", error, { rpcUrl: url })
    return false
  }
}

export async function waitForRpcReady(rpcUrl: string, timeoutSec: number): Promise<void> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  while (nowMs() < deadlineMs) {
    if (await isRpcReady(rpcUrl)) return
    attempt++
    const backoffMs = Math.min(2000, 100 + attempt * 100)
    await sleep(backoffMs)
  }
  throw new Error(`RPC not ready at ${rpcUrl} after ${timeoutSec}s`)
}

export async function readWalletMnemonics(): Promise<string[]> {
  const explicit = splitCsv(process.env.WALLETS)
  if (explicit.length > 0) return explicit

  const dir = process.env.MNEMONICS_DIR ?? "testing/devnet/identities"
  const names = splitCsv(process.env.WALLET_FILES)
  const defaultFiles = names.length > 0 ? names : ["node1.identity", "node2.identity", "node3.identity", "node4.identity"]

  const mnemonics: string[] = []
  for (const file of defaultFiles) {
    const path = dir.replace(/\/+$/, "") + "/" + file
    const text = await Bun.file(path).text()
    const mnemonic = text.trim()
    if (mnemonic.length > 0) mnemonics.push(mnemonic)
  }

  return mnemonics
}

export function maybeSilenceConsole() {
  if (!envBool("QUIET", true)) return

  const allowedPrefixes = ["{", "["]
  const originalLog = console.log.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalInfo = console.info.bind(console)
  const originalDebug = console.debug.bind(console)

  const filter = (...args: any[]) => {
    if (args.length === 0) return
    const first = args[0]
    if (typeof first === "string") {
      const trimmed = first.trim()
      for (const p of allowedPrefixes) {
        if (trimmed.startsWith(p)) return originalLog(...args)
      }
      return
    }
    return originalLog(...args)
  }

  console.log = filter as any
  console.info = filter as any
  console.debug = () => {}
  console.warn = (...args: any[]) => originalWarn(...args)

  ;(globalThis as any).__loadgenConsole = { originalLog, originalWarn, originalInfo, originalDebug }
}

export function getTokenTargets(): string[] {
  const targets = splitCsv(process.env.TARGETS).length > 0
    ? splitCsv(process.env.TARGETS)
    : ["http://node-1:53551"]
  return targets.map(normalizeRpcUrl)
}

export type TokenBootstrapResult = {
  tokenAddress: string
  walletAddresses: string[]
}

type GCREdit = {
  type: string
  [key: string]: any
}

export async function getWalletAddresses(rpcUrl: string, mnemonics: string[]): Promise<string[]> {
  const addresses: string[] = []
  for (const mnemonic of mnemonics) {
    const demos = new Demos()
    await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
    await demos.connect(rpcUrl)
    await demos.connectWallet(mnemonic, { algorithm: "ed25519" })
    const sender = (await demos.crypto.getIdentity("ed25519")).publicKey
    addresses.push(uint8ArrayToHex(sender as Uint8Array))
  }
  return addresses
}

export async function withDemosWallet<T>(params: {
  rpcUrl: string
  mnemonic: string
  waitForRpcSec?: number
  waitForTxSec?: number
  fn: (demos: Demos, addressHex: string) => Promise<T>
}): Promise<T> {
  const demos = new Demos()
  await waitForRpcReady(params.rpcUrl, params.waitForRpcSec ?? envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(params.rpcUrl, params.waitForTxSec ?? envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(params.rpcUrl)
  await demos.connectWallet(params.mnemonic, { algorithm: "ed25519" })
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const addressHex = uint8ArrayToHex(publicKey as Uint8Array)
  return params.fn(demos, addressHex)
}

function buildGasAndNonceEdits(fromEd25519Address: string): GCREdit[] {
  return [
    {
      type: "balance",
      account: fromEd25519Address,
      operation: "remove",
      amount: 1,
      txhash: "",
      isRollback: false,
    },
    {
      type: "nonce",
      operation: "add",
      account: fromEd25519Address,
      amount: 1,
      txhash: "",
      isRollback: false,
    },
  ]
}

async function signTxWithEdits(demos: Demos, tx: any, edits: GCREdit[]): Promise<any> {
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  tx.content.from = fromHex
  tx.content.from_ed25519_address = fromHex
  tx.content.gcr_edits = edits

  tx.hash = Hashing.sha256(JSON.stringify(tx.content))
  const signatureBytes = Cryptography.sign(tx.hash, (demos as any).keypair.privateKey)
  tx.signature = { type: "ed25519", data: uint8ArrayToHex(signatureBytes) }
  return tx
}

function deriveTokenAddress(deployer: string, deployerNonce: number, tokenObjectHash: string): string {
  const addrHex = Hashing.sha256(`${deployer}:${deployerNonce}:${tokenObjectHash}`)
  return "0x" + addrHex
}

function getDefaultTokenName(): string {
  const runId = (process.env.RUN_ID ?? "").trim()
  const scenario = (process.env.SCENARIO ?? "").trim()
  if (runId) return `Perf Token ${runId}`
  if (scenario) return `Perf Token ${scenario}`
  return "Perf Token"
}

function isTokenAlreadyExistsError(response: any): boolean {
  const message = typeof response?.extra?.error === "string"
    ? response.extra.error
    : typeof response?.response === "string"
      ? response.response
      : ""
  return message.includes("Token already exists at address")
}

async function findReusableTokenAddress(params: {
  rpcUrl: string
  ownerAddress: string
  excludeAddresses: string[]
  minOwnerBalance: bigint
  timeoutSec: number
}): Promise<string | null> {
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const owner = normalizeHexAddress(params.ownerAddress)
  const excluded = new Set((params.excludeAddresses ?? []).map(normalizeHexAddress))

  while (nowMs() < deadlineMs) {
    const pointers = await nodeCall(params.rpcUrl, "token.getHolderPointers", { address: owner }, "token.getHolderPointers:reuse")
    const tokensRaw = pointers?.response?.tokens
    const list = Array.isArray(tokensRaw) ? tokensRaw : []
    const tokenAddresses = list.map(normalizeTokenPointerEntry).filter(Boolean) as string[]

    for (const tokenAddress of tokenAddresses.slice().reverse()) {
      const token = await nodeCall(params.rpcUrl, "token.get", { tokenAddress }, `token.get:reuse:${tokenAddress}`)
      if (token?.result !== 200) continue
      const accessControl = token?.response?.accessControl
      const tokenOwner = normalizeHexAddress(accessControl?.owner ?? "")
      const paused = !!accessControl?.paused
      const entries = Array.isArray(accessControl?.entries) ? accessControl.entries : []
      if (paused) continue
      if (tokenOwner !== owner) continue

      let clean = true
      for (const entry of entries) {
        const addr = normalizeHexAddress(entry?.address ?? "")
        if (!addr) continue
        if (addr === owner) continue
        if (excluded.has(addr)) {
          clean = false
          break
        }
      }
      if (!clean) continue

      const balRes = await nodeCall(params.rpcUrl, "token.getBalance", { tokenAddress, address: owner }, `token.getBalance:reuse:${owner}`)
      if (balRes?.result !== 200) continue
      const bal = typeof balRes?.response?.balance === "string" ? BigInt(balRes.response.balance) : 0n
      if (bal < params.minOwnerBalance) continue

      return normalizeHexAddress(tokenAddress)
    }

    await sleep(500)
  }

  return null
}

export async function ensureTokenAndBalances(
  rpcUrl: string,
  deployerMnemonic: string,
  walletAddresses: string[],
): Promise<TokenBootstrapResult> {
  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(deployerMnemonic, { algorithm: "ed25519" })
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await waitForChainReady(rpcUrl, envInt("WAIT_FOR_CHAIN_SEC", 120))

  const bootstrap = envBool("TOKEN_BOOTSTRAP", true)
  const distribute = envBool("TOKEN_DISTRIBUTE", true)

  const existing = (process.env.TOKEN_ADDRESS ?? "").trim()
  let tokenAddress = existing

  if (!bootstrap) {
    if (!tokenAddress) throw new Error("TOKEN_ADDRESS is required when TOKEN_BOOTSTRAP=false")
    return { tokenAddress, walletAddresses }
  }

  if (!tokenAddress) {
    const name = process.env.TOKEN_NAME ?? getDefaultTokenName()
    const ticker = process.env.TOKEN_TICKER ?? "PERF"
    const decimals = envInt("TOKEN_DECIMALS", 18)
    const initialSupply = BigInt(process.env.TOKEN_INITIAL_SUPPLY ?? "1000000000000000000000000")

    const deployerAddress = walletAddresses[0]!
    const currentNonce = await demos.getAddressNonce(deployerAddress)
    const nextNonce = Number(currentNonce) + 1

    const tokenBody = { name, ticker, decimals, initialSupply: initialSupply.toString() }
    const tokenObjectHash = Hashing.sha256(JSON.stringify(tokenBody))
    tokenAddress = deriveTokenAddress(deployerAddress, nextNonce, tokenObjectHash)

    const now = Date.now()
    const tokenData = {
      metadata: {
        name,
        ticker,
        decimals,
        address: tokenAddress,
        deployer: deployerAddress,
        deployerNonce: nextNonce,
        deployedAt: now,
        hasScript: false,
      },
      state: {
        totalSupply: initialSupply.toString(),
        balances: { [deployerAddress]: initialSupply.toString() },
        allowances: {},
        customState: {},
      },
      accessControl: {
        owner: deployerAddress,
        paused: false,
        entries: [],
      },
    }

    const tx = (demos as any).tx.empty()
    // IMPORTANT: keep tx.content.type="native" so nodes do not try to execute the payload
    // via the demosWork script engine (which expects DemoScript.operationOrder, etc.).
    // Token state changes are driven by consensus-applied GCR edits (type:"token") anyway.
    tx.content.type = "native"
    tx.content.to = deployerAddress
    tx.content.amount = 0
    tx.content.nonce = nextNonce
    tx.content.timestamp = now
    tx.content.data = ["token", { operation: "create", tokenAddress }]

    const tokenEdit = {
      type: "token",
      operation: "create",
      account: deployerAddress,
      txhash: "",
      isRollback: false,
      data: { tokenData, tokenAddress },
    }

    const edits = [...buildGasAndNonceEdits(deployerAddress), tokenEdit]
    const signedTx = await signTxWithEdits(demos, tx, edits)
    const validity = await (demos as any).confirm(signedTx)
    if (validity?.result !== 200) {
      throw new Error(`Token create confirm failed: ${JSON.stringify(validity)}`)
    }
    const res = await (demos as any).broadcast(validity)
    if (res?.result !== 200) {
      if (!isTokenAlreadyExistsError(res)) {
        throw new Error(`Token create broadcast failed: ${JSON.stringify(res)}`)
      }
    }

    try {
      await waitForTokenExists(rpcUrl, tokenAddress, envInt("TOKEN_WAIT_EXISTS_SEC", 30))
    } catch (err) {
      if (!envBool("TOKEN_FALLBACK_REUSE", true)) throw err

      const distributeAmount = BigInt(process.env.TOKEN_DISTRIBUTE_AMOUNT ?? "100000000000000000000000")
      const minOwnerBalance = distributeAmount * BigInt(Math.max(0, walletAddresses.length - 1))
      const reuse = await findReusableTokenAddress({
        rpcUrl,
        ownerAddress: deployerAddress,
        excludeAddresses: walletAddresses.slice(1),
        minOwnerBalance,
        timeoutSec: envInt("TOKEN_REUSE_TIMEOUT_SEC", 20),
      })
      if (!reuse) throw err
      tokenAddress = reuse
    }
  }

  if (distribute) {
    await waitForTokenExists(rpcUrl, tokenAddress, envInt("TOKEN_WAIT_EXISTS_SEC", 30))
    const perWallet = BigInt(process.env.TOKEN_DISTRIBUTE_AMOUNT ?? "100000000000000000000000")
    const deployerAddress = walletAddresses[0]!
    const currentNonce = await demos.getAddressNonce(deployerAddress)
    let nextNonce = Number(currentNonce) + 1
    for (const addr of walletAddresses) {
      if (addr === deployerAddress) continue

      const existingBalRes = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: addr }, `token.getBalance:bootstrap:${addr}`)
      const existingBal = typeof existingBalRes?.response?.balance === "string"
        ? BigInt(existingBalRes.response.balance)
        : 0n
      const needed = existingBal >= perWallet ? 0n : perWallet - existingBal
      if (needed <= 0n) continue

      const tx = (demos as any).tx.empty()
      tx.content.type = "native"
      tx.content.to = addr
      tx.content.amount = 0
      tx.content.nonce = nextNonce++
      tx.content.timestamp = Date.now()
      tx.content.data = ["token", { operation: "transfer", tokenAddress, to: addr, amount: needed.toString() }]

      const tokenEdit = {
        type: "token",
        operation: "transfer",
        account: deployerAddress,
        tokenAddress,
        txhash: "",
        isRollback: false,
        data: { from: deployerAddress, to: addr, amount: needed.toString() },
      }

      const edits = [...buildGasAndNonceEdits(deployerAddress), tokenEdit]
      const signedTx = await signTxWithEdits(demos, tx, edits)
      const validity = await (demos as any).confirm(signedTx)
      if (validity?.result !== 200) {
        throw new Error(`Token distribute confirm failed: ${JSON.stringify(validity)}`)
      }
      const res = await (demos as any).broadcast(validity)
      if (res?.result !== 200) {
        throw new Error(`Token distribute transfer failed: ${JSON.stringify(res)}`)
      }
    }

    const waitDist = envBool("TOKEN_WAIT_DISTRIBUTION", true)
    if (waitDist) {
      for (const addr of walletAddresses) {
        if (addr === deployerAddress) continue
        await waitForTokenBalanceAtLeast(
          rpcUrl,
          tokenAddress,
          addr,
          perWallet,
          envInt("TOKEN_WAIT_DISTRIBUTION_SEC", 60),
        )
      }
    }
  }

  return { tokenAddress, walletAddresses }
}

export async function sendTokenTransferTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  to: string
  amount: bigint
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.to
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    {
      operation: "transfer",
      tokenAddress: params.tokenAddress,
      to: params.to,
      amount: params.amount.toString(),
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "transfer",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { from: fromHex, to: params.to, amount: params.amount.toString() },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function buildSignedTokenTransferTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  to: string
  amount: bigint
  nonce: number
  timestamp?: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.to
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = typeof params.timestamp === "number" ? params.timestamp : Date.now()
  tx.content.data = [
    "token",
    {
      operation: "transfer",
      tokenAddress: params.tokenAddress,
      to: params.to,
      amount: params.amount.toString(),
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "transfer",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { from: fromHex, to: params.to, amount: params.amount.toString() },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  return { signedTx, fromHex }
}

export async function sendTokenMintTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  to: string
  amount: bigint
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.to
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    {
      operation: "mint",
      tokenAddress: params.tokenAddress,
      to: params.to,
      amount: params.amount.toString(),
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "mint",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { to: params.to, amount: params.amount.toString() },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenGrantPermissionTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  grantee: string
  permissions: string[]
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.grantee
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    {
      operation: "grantPermission",
      tokenAddress: params.tokenAddress,
      grantee: params.grantee,
      permissions: params.permissions,
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "grantPermission",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { grantee: params.grantee, permissions: params.permissions },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenRevokePermissionTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  grantee: string
  permissions: string[]
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.grantee
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    {
      operation: "revokePermission",
      tokenAddress: params.tokenAddress,
      grantee: params.grantee,
      permissions: params.permissions,
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "revokePermission",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { grantee: params.grantee, permissions: params.permissions },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenPauseTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = fromHex
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = ["token", { operation: "pause", tokenAddress: params.tokenAddress }]

  const tokenEdit = {
    type: "token",
    operation: "pause",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: {},
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenUnpauseTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = fromHex
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = ["token", { operation: "unpause", tokenAddress: params.tokenAddress }]

  const tokenEdit = {
    type: "token",
    operation: "unpause",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: {},
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenTransferOwnershipTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  newOwner: string
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.newOwner
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = ["token", { operation: "transferOwnership", tokenAddress: params.tokenAddress, newOwner: params.newOwner }]

  const tokenEdit = {
    type: "token",
    operation: "transferOwnership",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { newOwner: params.newOwner },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenUpgradeScriptTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  scriptCode: string
  methodNames: string[]
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const code = String(params.scriptCode ?? "")
  const codeHash = Hashing.sha256(code)

  const newScript = {
    version: 1,
    code,
    methods: (params.methodNames ?? []).map(name => ({
      name,
      params: [],
      returns: "any",
      mutates: false,
    })),
    hooks: [],
    codeHash,
    upgradedAt: Date.now(),
  }

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = fromHex
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    { operation: "upgradeScript", tokenAddress: params.tokenAddress, newScript, upgradeReason: "better_testing scripted token smoke" },
  ]

  const tokenEdit = {
    type: "token",
    operation: "upgradeScript",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { newScript, upgradeReason: "better_testing scripted token smoke" },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  if (validity?.result !== 200) {
    throw new Error(`Token upgradeScript confirm failed: ${JSON.stringify(validity)}`)
  }
  const res = await (demos as any).broadcast(validity)
  if (res?.result !== 200) {
    throw new Error(`Token upgradeScript broadcast failed: ${JSON.stringify(res)}`)
  }
  return { res, fromHex, codeHash }
}

export async function sendTokenUpdateAclTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  action: "grant" | "revoke"
  targetAddress: string
  permissions: string[]
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const fromHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.targetAddress
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    {
      operation: "updateACL",
      tokenAddress: params.tokenAddress,
      action: params.action,
      targetAddress: params.targetAddress,
      permissions: params.permissions,
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "updateACL",
    account: fromHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { action: params.action, targetAddress: params.targetAddress, permissions: params.permissions },
  }

  const edits = [...buildGasAndNonceEdits(fromHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, fromHex }
}

export async function sendTokenBurnTxWithDemos(params: {
  demos: Demos
  tokenAddress: string
  from: string
  amount: bigint
  nonce: number
}) {
  const { demos } = params
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const callerHex = uint8ArrayToHex(publicKey as Uint8Array)

  const tx = (demos as any).tx.empty()
  tx.content.type = "native"
  tx.content.to = params.from
  tx.content.amount = 0
  tx.content.nonce = params.nonce
  tx.content.timestamp = Date.now()
  tx.content.data = [
    "token",
    {
      operation: "burn",
      tokenAddress: params.tokenAddress,
      from: params.from,
      amount: params.amount.toString(),
    },
  ]

  const tokenEdit = {
    type: "token",
    operation: "burn",
    account: callerHex,
    tokenAddress: params.tokenAddress,
    txhash: "",
    isRollback: false,
    data: { from: params.from, amount: params.amount.toString() },
  }

  const edits = [...buildGasAndNonceEdits(callerHex), tokenEdit]
  const signedTx = await signTxWithEdits(demos, tx, edits)
  const validity = await (demos as any).confirm(signedTx)
  const res = await (demos as any).broadcast(validity)
  return { res, callerHex }
}

export function pickRecipient(recipients: string[], senderHex: string, workerId: number, avoidSelf: boolean): string {
  if (!avoidSelf) return recipients[workerId % recipients.length]!
  const senderNorm = normalizeHexAddress(senderHex)
  for (let i = 0; i < recipients.length; i++) {
    const candidate = recipients[(workerId + i) % recipients.length]!
    if (normalizeHexAddress(candidate) !== senderNorm) return candidate
  }
  throw new Error("Recipient set only contains the sender address (self-send avoided). Provide a different recipient.")
}
