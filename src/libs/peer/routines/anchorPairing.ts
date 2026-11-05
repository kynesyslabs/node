/**
 * Pairing with the anchors in the local peer list.
 *
 * An anchor that does not answer is not evidence against this node: it may be
 * down or still booting, and validators that restart together come up in any
 * order. Such an anchor is left behind at boot and checked once it answers.
 * An anchor that answers and refuses (unsigned hello, someone else's key at
 * its URL, another chain, genesis data this node cannot accept) is evidence
 * that this node, or its configuration, is wrong, and stops the boot.
 *
 * Free of network and file imports so the decisions can be tested; the caller
 * passes the hello and the genesis checks in.
 */

import log from "src/utilities/logger"
import type Peer from "../Peer"
import type { HelloVerdict } from "../PeerManager"

/** Waits between hellos to one anchor at boot: about 15 s before it is left behind. */
export const BOOT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]
export const DEFERRED_FIRST_DELAY_MS = 5000
export const DEFERRED_MAX_DELAY_MS = 60_000
/** How soon an anchor that hellos us on its own gets its checks. */
export const DEFERRED_TICK_MS = 2000

export class AnchorRefusal extends Error {
    constructor(message: string) {
        super(message)
        this.name = "AnchorRefusal"
    }
}

export interface AnchorPairingDeps {
    sayHello: (peer: Peer) => Promise<HelloVerdict>
    isPaired: (identity: string) => boolean
    sleep: (ms: number) => Promise<unknown>
}

export interface DeferredAnchorDeps extends AnchorPairingDeps {
    /** The genesis checks bootstrap runs on a paired anchor; throws AnchorRefusal. */
    confirm: (peer: Peer) => Promise<void>
    now: () => number
    /**
     * `fatal` is true while no anchor has confirmed this node: the refusal is
     * then the check bootstrap would have failed on.
     */
    onRefusal: (peer: Peer, refusal: Error, fatal: boolean) => void
}

function anchorLabel(peer: Peer) {
    return `${peer.identity} @ ${peer.connection.string}`
}

export function refusalFor(verdict: HelloVerdict, peer: Peer, chainHash: string): AnchorRefusal | null {
    switch (verdict) {
        case "unsigned":
            return new AnchorRefusal(
                `Anchor ${anchorLabel(peer)} answered without a signed hello: it runs pre-signature code. Pick an up-to-date anchor.`,
            )
        case "invalid":
            return new AnchorRefusal(
                `Anchor ${anchorLabel(peer)} failed identity verification: the URL is not served by that key.`,
            )
        case "other-genesis":
            return new AnchorRefusal(
                `Anchor ${anchorLabel(peer)} runs another chain: its genesis block hash differs from this node's ` +
                    `(${chainHash}). Check data/genesis.json and EXPECTED_GENESIS_HASH, or pick an anchor on this network.`,
            )
        default:
            return null
    }
}

/**
 * Hellos one anchor, waiting `delays` between attempts. Throws AnchorRefusal
 * when it answers and refuses; "unreachable" when it never answered.
 */
export async function pairWithAnchor(
    peer: Peer,
    deps: AnchorPairingDeps,
    chainHash: string,
    delays: number[] = BOOT_RETRY_DELAYS_MS,
): Promise<"paired" | "unreachable"> {
    let answered = false
    for (let attempt = 0; ; attempt++) {
        const verdict = await deps.sayHello(peer)
        const refusal = refusalFor(verdict, peer, chainHash)
        if (refusal) throw refusal
        if (verdict === "verified" && deps.isPaired(peer.identity)) return "paired"
        // A signed answer that still left it out of the table (no genesis hash
        // in the reply, URL bound to another key) will not change by waiting.
        answered ||= verdict === "verified"
        if (attempt >= delays.length) break
        log.warn(
            `[BOOTSTRAP] Anchor ${anchorLabel(peer)} not paired yet (${verdict}), retrying in ${delays[attempt]} ms`,
        )
        await deps.sleep(delays[attempt])
    }
    if (answered) {
        throw new AnchorRefusal(`Failed to pair with anchor peer: ${anchorLabel(peer)}`)
    }
    return "unreachable"
}

/**
 * Hellos every anchor at once, so boot waits for the slowest anchor rather
 * than the sum of them. Throws the first refusal in list order.
 */
export async function pairAnchorsAtBoot(
    anchors: Peer[],
    deps: AnchorPairingDeps,
    chainHash: string,
    delays: number[] = BOOT_RETRY_DELAYS_MS,
): Promise<{ paired: Peer[]; unreachable: Peer[] }> {
    const results = await Promise.allSettled(
        anchors.map(peer => pairWithAnchor(peer, deps, chainHash, delays)),
    )
    const paired: Peer[] = []
    const unreachable: Peer[] = []
    for (const [i, result] of results.entries()) {
        if (result.status === "rejected") throw result.reason
        if (result.value === "paired") paired.push(anchors[i])
        else unreachable.push(anchors[i])
    }
    return { paired, unreachable }
}

interface PendingAnchor {
    peer: Peer
    nextAttemptAt: number
    delay: number
    /** Paired when last tried; an anchor that pairs by its own hello is due at once. */
    pairedAtLastTry: boolean
}

/**
 * Keeps trying the anchors that did not answer at boot and runs on each the
 * checks bootstrap would have run. A refusal stops the node while no anchor
 * has confirmed it yet, exactly as at boot. Once one has, a refusing anchor is
 * dropped instead: that anchor is the odd one out, and one misconfigured
 * validator must not stop every running node that lists it.
 */
export class DeferredAnchorChecks {
    private readonly pending = new Map<string, PendingAnchor>()
    private stopped = false

    constructor(
        anchors: Peer[],
        private readonly deps: DeferredAnchorDeps,
        private readonly chainHash: string,
        private confirmed: boolean,
    ) {
        const start = deps.now()
        for (const peer of anchors) {
            this.pending.set(peer.identity, {
                peer,
                nextAttemptAt: start + DEFERRED_FIRST_DELAY_MS,
                delay: DEFERRED_FIRST_DELAY_MS,
                pairedAtLastTry: false,
            })
        }
    }

    get pendingIdentities(): string[] {
        return [...this.pending.keys()]
    }

    get isConfirmed(): boolean {
        return this.confirmed
    }

    stop() {
        this.stopped = true
    }

    async run(): Promise<void> {
        while (!this.stopped && this.pending.size > 0) {
            await this.tick()
            if (this.stopped || this.pending.size === 0) break
            await this.deps.sleep(DEFERRED_TICK_MS)
        }
    }

    /** One pass over the anchors that are due; sequential, so genesis checks never overlap. */
    async tick(): Promise<void> {
        for (const entry of [...this.pending.values()]) {
            if (this.stopped) return
            const pairedNow = this.deps.isPaired(entry.peer.identity)
            const due =
                this.deps.now() >= entry.nextAttemptAt ||
                (pairedNow && !entry.pairedAtLastTry)
            if (!due) continue
            await this.check(entry)
        }
    }

    private async check(entry: PendingAnchor) {
        const { peer } = entry
        entry.pairedAtLastTry = this.deps.isPaired(peer.identity)
        try {
            const outcome = await pairWithAnchor(peer, this.deps, this.chainHash, [])
            if (outcome === "unreachable") {
                this.backOff(entry, "still not answering")
                return
            }
            await this.deps.confirm(peer)
            this.pending.delete(peer.identity)
            this.confirmed = true
            log.info(`[BOOTSTRAP] OK: anchor ${anchorLabel(peer)} came up and passed the bootstrap checks`)
        } catch (error) {
            if (!(error instanceof AnchorRefusal)) {
                this.backOff(
                    entry,
                    "check failed: " + (error instanceof Error ? error.message : String(error)),
                )
                return
            }
            this.pending.delete(peer.identity)
            const fatal = !this.confirmed
            if (fatal) this.stopped = true
            this.deps.onRefusal(peer, error, fatal)
        }
    }

    private backOff(entry: PendingAnchor, reason: string) {
        entry.delay = Math.min(entry.delay * 2, DEFERRED_MAX_DELAY_MS)
        entry.nextAttemptAt = this.deps.now() + entry.delay
        log.debug(
            `[BOOTSTRAP] Anchor ${anchorLabel(entry.peer)} ${reason}; next try in ${entry.delay} ms`,
        )
    }
}
