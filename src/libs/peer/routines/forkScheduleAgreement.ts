/**
 * Agreement on the fork schedule between this node and a peer.
 *
 * The schedule lives in each node's genesis file and is not part of the
 * genesis data hash (see normalizeGenesisForHash.ts), so a node that missed
 * the edit would pair with everyone and then split from them at the
 * activation height. This compares what the two nodes report through
 * `getNetworkInfo` so the operator hears about it at boot.
 */

export interface ScheduleView {
    chainId: number | null | undefined
    /** activationHeight per fork the node reported; a fork the node does not report is absent. */
    forks: Record<string, number | null>
}

const COMPARED_FORKS = [
    "osDenomination",
    "signatureDomain",
    "web2ProofBinding",
] as const

/** This node's view, from its loaded fork configuration. */
export function localScheduleView(
    forkConfig: Record<string, { activationHeight: number | null } | undefined>,
    chainId: number | null,
): ScheduleView {
    const forks: Record<string, number | null> = {}
    for (const name of COMPARED_FORKS) {
        const entry = forkConfig[name]
        if (entry) forks[name] = entry.activationHeight
    }
    return { chainId, forks }
}

/** A peer's view from its `getNetworkInfo` answer, or null when the answer has no fork table. */
export function peerScheduleView(info: unknown): ScheduleView | null {
    if (info === null || typeof info !== "object") return null
    const { forks, chainId } = info as {
        forks?: Record<string, { activationHeight?: number | null } | undefined>
        chainId?: number | null
    }
    if (!forks || typeof forks !== "object") return null
    const out: Record<string, number | null> = {}
    for (const name of COMPARED_FORKS) {
        const entry = forks[name]
        if (entry && entry.activationHeight !== undefined) {
            out[name] = entry.activationHeight
        }
    }
    return { chainId, forks: out }
}

/**
 * Differences between two views, as readable lines. Only what both sides
 * report is compared: a peer on an older build that does not report a fork
 * (or the chain id) says nothing about it.
 */
export function diffSchedules(ours: ScheduleView, theirs: ScheduleView): string[] {
    const lines: string[] = []
    for (const name of COMPARED_FORKS) {
        if (!(name in ours.forks) || !(name in theirs.forks)) continue
        if (ours.forks[name] !== theirs.forks[name]) {
            lines.push(
                `${name}: ours ${String(ours.forks[name])}, theirs ${String(theirs.forks[name])}`,
            )
        }
    }
    if (theirs.chainId !== undefined && ours.chainId !== theirs.chainId) {
        lines.push(`chainId: ours ${String(ours.chainId)}, theirs ${String(theirs.chainId)}`)
    }
    return lines
}
