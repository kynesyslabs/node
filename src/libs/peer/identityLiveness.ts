import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { parseNodeUrl } from "src/config"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"
import { helloResponseMessage } from "./helloAuth"
import { countSelfIdentitySeen } from "../gossip/metrics"
import Peer from "./Peer"
import PeerManager from "./PeerManager"

export class IdentityLiveError extends Error {
    constructor(public readonly url: string) {
        super(
            `identity ${getSharedState.publicKeyHex} is already live at ${url}`,
        )
        this.name = "IdentityLiveError"
    }
}

const candidates = new Set<string>()
const reported = new Set<string>()

/** Record a URL where a hello responder says our identity is already online. */
export function noteCallerKnownAt(url: unknown): void {
    const origin = typeof url === "string" ? parseNodeUrl(url)?.origin : null
    const ours = parseNodeUrl(getSharedState.exposedUrl)?.origin
    if (origin && origin !== ours) candidates.add(origin)
}

/** Log once per location that another process is using our identity, and count it. */
export function reportTwin(source: "hello" | "heights", where: string): void {
    countSelfIdentitySeen(source)
    if (reported.has(where)) return
    reported.add(where)
    log.error(
        `[IDENTITY] another process is using our identity ${getSharedState.publicKeyHex} at ${where} (seen via ${source})`,
    )
}

type Verify = (input: {
    algorithm: string
    message: Uint8Array
    signature: Uint8Array
    publicKey: Uint8Array
}) => Promise<boolean>

/** True when a hello reply is a "Peer is us" signed over our nonce by our own key. */
export async function isSelfProof(
    extra: Record<string, unknown> | undefined,
    nonce: string,
    dialedUrl: string,
    verify: Verify,
): Promise<boolean> {
    if (typeof extra?.msg !== "string" || !extra.msg.startsWith("Peer is us")) {
        return false
    }
    const { identity, url, signature } = extra as {
        identity?: unknown
        url?: unknown
        signature?: { type?: string; data?: unknown }
    }
    if (
        typeof identity !== "string" ||
        typeof url !== "string" ||
        !signature?.type ||
        typeof signature.data !== "string"
    ) {
        return false
    }
    if (identity.toLowerCase() !== getSharedState.publicKeyHex.toLowerCase()) {
        return false
    }
    if (parseNodeUrl(url)?.origin !== parseNodeUrl(dialedUrl)?.origin) {
        return false
    }
    return verify({
        algorithm: signature.type,
        message: helloResponseMessage(nonce, url),
        signature: hexToUint8Array(signature.data),
        publicKey: hexToUint8Array(identity),
    })
}

/** Hello every URL noted during bootstrap; throw if one proves it holds our key. */
export async function assertIdentityNotLive(): Promise<void> {
    const urls = [...candidates]
    candidates.clear()
    if (urls.length === 0) return
    log.info(
        `[IDENTITY] peers report our identity online elsewhere; probing ${urls.join(", ")}`,
    )
    const verify: Verify = input =>
        TxValidatorPool.getInstance().verify(
            input as Parameters<TxValidatorPool["verify"]>[0],
        )
    for (const url of urls) {
        const { request, nonce } = await PeerManager.buildHelloRequest()
        let response
        try {
            response = await new Peer(
                url,
                getSharedState.publicKeyHex,
            ).longCall({ method: "hello_peer", params: [request] }, true, {
                sleepTime: 250,
                retries: 1,
                allowedCodes: [500, 504],
            })
        } catch (e) {
            log.warning(
                `[IDENTITY] probe of ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
            )
            continue
        }
        if (
            response?.result === 200 &&
            (await isSelfProof(response.extra, nonce, url, verify))
        ) {
            throw new IdentityLiveError(url)
        }
        log.info(`[IDENTITY] ${url} did not prove our identity; continuing`)
    }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetIdentityLiveness(): void {
    candidates.clear()
    reported.clear()
}
