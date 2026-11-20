// The anchor node side of a proof: a synced RPC is asked about seats, and
// the wallet-signed proof is sent to Solana through this node's endpoints.
import { readFileSync } from "node:fs"

import { Demos } from "@kynesyslabs/demosdk/websdk"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { withSolana } from "./solanaRpc"
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

/**
 * Whether this node's address holds an active or unstaking seat at the
 * anchor's head. Only a definite answer is cached: a validator row with a
 * status, or null for no row. Any other reply (an error body, a row without
 * a status) says nothing about the seat, so it is reported as an unreachable
 * anchor instead of being kept for SEAT_CACHE_MS as "no seat".
 */
export async function nodeHoldsSeat(ownAddress: string): Promise<boolean> {
    if (seatCache !== null && Date.now() - seatCache.at < SEAT_CACHE_MS) return seatCache.holds
    const demos = await anchorClient()
    let info: unknown
    try {
        info = await demos.getValidatorInfo(ownAddress)
    } catch (e) {
        throw new AnchorUnreachableError(`getValidatorInfo: ${e instanceof Error ? e.message : String(e)}`)
    }
    let holds: boolean
    if (info === null) {
        holds = false
    } else if (isRecord(info) && typeof info.status === "string") {
        holds = SEAT_HOLDING_STATUSES.has(info.status)
    } else {
        throw new AnchorUnreachableError(`getValidatorInfo: unexpected reply ${describeReply(info)}`)
    }
    seatCache = { at: Date.now(), holds }
    return holds
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeReply(value: unknown): string {
    return (JSON.stringify(value) ?? String(value)).slice(0, 200)
}

/** The address whose seat `mint` currently backs at the anchor's head, or null. */
export async function mintHolder(mint: string): Promise<string | null> {
    const demos = await anchorClient()
    let info: unknown
    try {
        // A node call rather than an SDK helper: the SDK releases this node
        // builds with do not carry one.
        info = await demos.nodeCall("getValidatorByMint", { mint })
    } catch (e) {
        throw new AnchorUnreachableError(`getValidatorByMint: ${e instanceof Error ? e.message : String(e)}`)
    }
    // Same rule as nodeHoldsSeat: an error body is not "no holder"
    if (info === null) return null
    if (isRecord(info) && typeof info.address === "string") return info.address
    throw new AnchorUnreachableError(`getValidatorByMint: unexpected reply ${describeReply(info)}`)
}

/**
 * Sends the signed proof to Solana through this node's own endpoints. The
 * proof is already signed by the wallet, so nothing of the node's is spent.
 */
export async function sendProofToSolana(bytes: Uint8Array): Promise<RecordedProof> {
    try {
        const signature = await withSolana("sendRawTransaction(proof)", connection =>
            connection.sendRawTransaction(bytes),
        )
        log.info(`[STAKING PAGE] proof sent to Solana as ${signature}`)
        return { accepted: true, message: "proof sent to Solana" }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.warning(`[STAKING PAGE] proof refused by Solana: ${message}`)
        return { accepted: false, message }
    }
}
