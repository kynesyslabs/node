// The anchor node and the Demos side of a proof: a synced RPC is asked
// about seats, and the signed Solana proof is recorded on Demos as a
// crosschainOperation signed by this node's identity and sent to the anchor.
import { readFileSync } from "node:fs"

import { Demos, prepareXMPayload } from "@kynesyslabs/demosdk/websdk"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { proofXmScript } from "./proofBytes"
import { AnchorUnreachableError, type RecordedProof } from "./validationHandlers"

const SEAT_HOLDING_STATUSES = new Set(["2", "3"])
const SEAT_CACHE_MS = 10_000

/**
 * The Demos RPC asked about seats: the first peerlist entry that is not this
 * node, else this node's own exposed URL. This node's own database may be
 * behind the chain head, so it is never read directly.
 */
export function resolveAnchorRpc(
    peerlistText: () => string = () => readFileSync(getSharedState.peerListFile, "utf8"),
    ownUrl: string = getSharedState.exposedUrl,
): string | null {
    const own = ownUrl.trim().replace(/\/+$/, "")
    let peers: unknown = null
    try {
        peers = JSON.parse(peerlistText())
    } catch {
        peers = null
    }
    if (peers && typeof peers === "object") {
        for (const url of Object.values(peers as Record<string, unknown>)) {
            if (typeof url !== "string") continue
            const trimmed = url.trim().replace(/\/+$/, "")
            if (trimmed !== "" && trimmed !== own) return trimmed
        }
    }
    return own === "" ? null : own
}

async function anchorClient(): Promise<Demos> {
    const url = resolveAnchorRpc()
    if (url === null) {
        throw new AnchorUnreachableError("no anchor RPC: the peerlist is empty and this node has no exposed URL")
    }
    const demos = new Demos()
    try {
        await demos.connect(url)
    } catch (e) {
        throw new AnchorUnreachableError(`${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
    return demos
}

let seatCache: { at: number; holds: boolean } | null = null

export function resetAnchorCacheForTesting(): void {
    seatCache = null
}

/** Whether this node's address holds an active or unstaking seat at the anchor's head. */
export async function nodeHoldsSeat(ownAddress: string): Promise<boolean> {
    if (seatCache !== null && Date.now() - seatCache.at < SEAT_CACHE_MS) return seatCache.holds
    const demos = await anchorClient()
    let info: { status?: string } | null
    try {
        info = (await demos.getValidatorInfo(ownAddress)) as { status?: string } | null
    } catch (e) {
        throw new AnchorUnreachableError(`getValidatorInfo: ${e instanceof Error ? e.message : String(e)}`)
    }
    const holds = info !== null && typeof info.status === "string" && SEAT_HOLDING_STATUSES.has(info.status)
    seatCache = { at: Date.now(), holds }
    return holds
}

/** The address whose seat `mint` currently backs at the anchor's head, or null. */
export async function mintHolder(mint: string): Promise<string | null> {
    const demos = await anchorClient()
    try {
        const info = (await demos.getValidatorByMint(mint)) as { address?: string } | null
        return info && typeof info.address === "string" ? info.address : null
    } catch (e) {
        throw new AnchorUnreachableError(`getValidatorByMint: ${e instanceof Error ? e.message : String(e)}`)
    }
}

/** The mnemonic the node identity is derived from, as the SDK expects it. */
function nodeMnemonic(): string {
    return readFileSync(getSharedState.identityFile, "utf8").trim()
}

/**
 * Records a signed Solana proof on Demos: a crosschainOperation carrying
 * the bytes, signed by this node and sent to the anchor, which forwards the
 * Solana transaction and admits the Demos one.
 */
export async function recordProofOnDemos(bytes: Uint8Array): Promise<RecordedProof> {
    const demos = await anchorClient()
    await demos.connectWallet(nodeMnemonic())
    const tx = await prepareXMPayload(proofXmScript(bytes), demos)

    // The SDK throws on an invalid transaction at confirm and on a refused
    // broadcast; both are answers for the operator, not server faults.
    let validity: Awaited<ReturnType<Demos["confirm"]>>
    try {
        validity = await demos.confirm(tx)
    } catch (e) {
        const message = sdkReason(e)
        log.warning(`[STAKING PAGE] proof tx refused at confirm: ${message}`)
        return { accepted: false, demosTxHash: null, message }
    }
    const data = validity?.response?.data as
        | { valid?: boolean; message?: string; transaction?: { hash?: string } }
        | undefined
    const demosTxHash = data?.transaction?.hash ?? null
    if (!data?.valid || demosTxHash === null) {
        const message = data?.message ?? "anchor did not confirm the proof transaction"
        log.warning(`[STAKING PAGE] proof tx refused at confirm: ${message}`)
        return { accepted: false, demosTxHash, message }
    }

    let broadcast: { result?: number; response?: unknown; extra?: unknown }
    try {
        broadcast = (await demos.broadcast(validity)) as typeof broadcast
    } catch (e) {
        const message = sdkReason(e)
        log.warning(`[STAKING PAGE] proof tx ${demosTxHash} refused at broadcast: ${message}`)
        return { accepted: false, demosTxHash, message }
    }
    if (broadcast?.result !== 200) {
        const message = describeBroadcastFailure(broadcast)
        log.warning(`[STAKING PAGE] proof tx ${demosTxHash} refused at broadcast: ${message}`)
        return { accepted: false, demosTxHash, message }
    }
    log.info(`[STAKING PAGE] proof recorded on Demos as ${demosTxHash}`)
    return { accepted: true, demosTxHash, message: "proof sent to Solana and recorded on Demos" }
}

/** The SDK's error text without its "[Confirm] Transaction is not valid:" style prefix. */
function sdkReason(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return text.replace(/^\[(Confirm|Broadcast)\] Transaction is not valid:\s*/, "").trim() || "anchor refused the proof transaction"
}

export const sdkReasonForTesting = sdkReason

function describeBroadcastFailure(broadcast: { response?: unknown; extra?: unknown }): string {
    const response = broadcast.response as { message?: unknown; results?: unknown } | undefined
    if (response && typeof response === "object") {
        if (typeof response.message === "string" && response.message !== "all_ops_failed") return response.message
        if (response.results && typeof response.results === "object") {
            const errors = Object.values(response.results as Record<string, { error?: unknown }>)
                .map(r => r?.error)
                .filter(e => e !== undefined)
                .map(e => (typeof e === "string" ? e : JSON.stringify(e)))
            if (errors.length > 0) return `Solana send failed: ${errors.join("; ")}`
        }
    }
    const extra = broadcast.extra as { error?: unknown } | string | undefined
    if (typeof extra === "string") return extra
    if (extra && typeof extra === "object" && typeof extra.error === "string") return extra.error
    return "anchor rejected the proof transaction"
}
