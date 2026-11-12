/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import fs from "fs"
import axios from "axios"

import Peer from "../Peer"
import log from "src/utilities/logger"
import PeerManager from "../PeerManager"
import { sleep } from "@kynesyslabs/demosdk/utils"
import { RPCRequest } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { parseGenesisPin } from "@/libs/blockchain/genesis/genesisPin"
import { hashGenesisCore, hashGenesisData } from "@/libs/blockchain/genesis/normalizeGenesisForHash"
import Chain from "@/libs/blockchain/chain"
import {
    editedGenesisOnFreshChainProblem,
    resolveGenesisMismatch,
} from "./genesisMismatch"
import {
    checkPeerSchedule,
    localScheduleView,
    showPeerValue,
    type ForkConfigLike,
} from "./forkScheduleAgreement"
import { requestScheduleCheck } from "./forkScheduleWatch"
import { Config } from "src/config"
import { replaceFileAtomically } from "./replaceFileAtomically"
import {
    AnchorRefusal,
    DeferredAnchorChecks,
    pairAnchorsAtBoot,
    type AnchorPairingDeps,
} from "./anchorPairing"
import {
    clearRefusalMarker,
    pendingRefusal,
    writeRefusalMarker,
} from "./genesisRefusalMarker"
import { genesisFilePath } from "@/libs/blockchain/genesis/genesisFile"

let ourGenesisDataHash = ""
let ourGenesisCoreHash = ""
const refusalMarkerFile = "data/genesis.bootstrap-refused.json"
/** A genesis file is a few KB; this only bounds what a peer can make this node buffer. */
const MAX_GENESIS_BYTES = 2 * 1024 * 1024
const GENESIS_DOWNLOAD_TIMEOUT_MS = 10_000
const peerman = PeerManager.getInstance()
const discoveredGenesisDataHashes = new Set<string>()

/** Ask a peer for its advertised genesis data hash, retrying while it is not ready. */
async function fetchPeerGenesisHash(verifiedPeer: Peer) {
    const request: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getGenesisDataHash",
            },
        ],
    }

    let res: Awaited<ReturnType<typeof verifiedPeer.call>> = null
    const maxAttempts = 10
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        res = await verifiedPeer.call(request)
        log.debug("[BOOTSTRAP] Genesis data hash: " + showPeerValue(JSON.stringify(res)))

        if (res?.result === 200) {
            break
        }

        if (attempt < maxAttempts) {
            log.warn(
                `[BOOTSTRAP] Peer ${verifiedPeer.connection.string} is not ready to serve genesis data hash yet ` +
                    `(attempt ${attempt}/${maxAttempts}, result=${showPeerValue(res?.result)})`,
            )
            await sleep(1000)
        }
    }
    return res as NonNullable<typeof res>
}

/** The genesis check could not be completed; says nothing about the peer's genesis. */
class GenesisCheckUnavailable extends Error {}

async function downloadPeerGenesis(
    verifiedPeer: Peer,
    peerGenesisDataHash: string,
): Promise<unknown> {
    log.warn(
        "[BOOTSTRAP] Genesis data hash differs from the one " +
            verifiedPeer.connection.string +
            " advertises (ours " +
            ourGenesisDataHash +
            ", theirs " +
            showPeerValue(peerGenesisDataHash) +
            "); comparing the data it serves",
    )
    log.debug(
        "[BOOTSTRAP] Fetching new genesis data from peer: " +
            verifiedPeer.connection.string,
    )
    let served: { status: number; data: unknown }
    try {
        served = await axios.get(verifiedPeer.connection.string + "/genesis", {
            timeout: GENESIS_DOWNLOAD_TIMEOUT_MS,
            maxContentLength: MAX_GENESIS_BYTES,
            maxBodyLength: MAX_GENESIS_BYTES,
        })
    } catch (error) {
        throw new GenesisCheckUnavailable(
            "Could not download genesis data from " +
                verifiedPeer.connection.string +
                ": " +
                (error instanceof Error ? error.message : String(error)),
        )
    }
    if (served.status !== 200) {
        throw new GenesisCheckUnavailable(
            `Could not download genesis data from ${verifiedPeer.connection.string}: HTTP ${served.status}`,
        )
    }
    return served.data
}

function logGenesisVerdict(
    verdict: Awaited<ReturnType<typeof resolveGenesisMismatch>>,
    verifiedPeer: Peer,
) {
    if (verdict.outcome === "unhashed-fields-only") {
        log.warn(
            "[BOOTSTRAP] Peer " +
                verifiedPeer.connection.string +
                " serves genesis data that differs from ours only in the fork schedule or chain id; " +
                "keeping our " + genesisFilePath() + " as it is",
        )
        return
    }
    if (verdict.outcome === "peer-disagrees") {
        log.warn(
            "[BOOTSTRAP] Peer " +
                verifiedPeer.connection.string +
                " advertises genesis hash " +
                verdict.peerAdvertisedHash +
                ", which is not the one this node's genesis is anchored to; ignoring it and keeping " +
                "our " + genesisFilePath(),
        )
        return
    }
    if (verdict.outcome !== "replaced") return

    log.warn(
        "[BOOTSTRAP] Replaced " + genesisFilePath() + " with the data served by " +
            verifiedPeer.connection.string +
            (verdict.carriedOver.length > 0
                ? ", keeping our " + verdict.carriedOver.join(" and ")
                : ""),
    )
    // INFO: Update discovered genesis hashes and current genesis hash
    discoveredGenesisDataHashes.add(verdict.servedCoreHash)
    ourGenesisDataHash = verdict.writtenFullHash
    ourGenesisCoreHash = verdict.servedCoreHash

    // INFO: Ensure all peers have the same genesis data
    if (discoveredGenesisDataHashes.size > 1) {
        log.error("[BOOTSTRAP] Conflicting genesis data hashes found")
        throw new Error("Conflicting genesis data hashes found across peers")
    }
}

/** Hash of the genesis data in this node's stored block 0, or null when it has none. */
async function storedGenesisHash(): Promise<string | null> {
    const block = await Chain.getGenesisBlock()
    const content = block?.content as { extra?: { genesisData?: unknown } } | undefined
    let data = content?.extra?.genesisData
    if (!data) return null
    if (typeof data === "string") data = JSON.parse(data)
    return hashGenesisData(data)
}

function writeGenesisAtomically(data: unknown, expectedCoreHash: string) {
    const method = replaceFileAtomically(
        genesisFilePath(),
        JSON.stringify(data, null, 2),
        written => {
            if (hashGenesisCore(JSON.parse(written)) !== expectedCoreHash) {
                throw new Error(
                    "Genesis data written from peer does not hash like what the peer served",
                )
            }
        },
    )
    log.debug(`[BOOTSTRAP] Replaced ${genesisFilePath()} (${method})`)
}

async function ensureGenesisDataMatch(verifiedPeer: Peer) {
    const res = await fetchPeerGenesisHash(verifiedPeer)

    if (res.result === 200) {
        const peerGenesisDataHash = res.response
        // A block 0 created at this boot came from the local file, so it cannot vouch for it.
        const storedHash = getSharedState.genesisCreatedThisBoot
            ? null
            : await storedGenesisHash()

        const verdict = await resolveGenesisMismatch(
            ourGenesisDataHash,
            ourGenesisCoreHash,
            peerGenesisDataHash,
            {
                fetchPeerGenesis: () =>
                    downloadPeerGenesis(verifiedPeer, peerGenesisDataHash),
                readLocalGenesis: () =>
                    JSON.parse(fs.readFileSync(genesisFilePath(), "utf8")),
                writeGenesis: writeGenesisAtomically,
                hashFull: hashGenesisData,
                hashCore: hashGenesisCore,
            },
            {
                storedHash,
                expectedHash: parseGenesisPin(Config.getInstance().core.expectedGenesisHash),
            },
        )
        logGenesisVerdict(verdict, verifiedPeer)
        if (
            verdict.outcome === "unhashed-fields-only" &&
            getSharedState.genesisCreatedThisBoot
        ) {
            const problem = editedGenesisOnFreshChainProblem(
                await storedGenesisHash(),
                peerGenesisDataHash,
            )
            if (problem) {
                log.error("[BOOTSTRAP] Refusing to continue: " + problem)
                try {
                    writeRefusalMarker(refusalMarkerFile, {
                        message: problem,
                        storedHash: (await storedGenesisHash()) ?? "",
                        peerHash: peerGenesisDataHash,
                    })
                } catch (error) {
                    log.error(
                        `[BOOTSTRAP] Could not write ${refusalMarkerFile}: ` +
                            (error instanceof Error ? error.message : String(error)),
                    )
                }
                throw new Error(problem)
            }
        }
        if (storedHash !== null && peerGenesisDataHash === storedHash) {
            // A peer and this node's own stored block 0 agree: whatever an earlier refusal was about is gone.
            if (clearRefusalMarker(refusalMarkerFile)) {
                log.info(`[BOOTSTRAP] Removed ${refusalMarkerFile}: the stored block 0 agrees with the network`)
            }
        }
    } else {
        throw new GenesisCheckUnavailable(
            "Failed to get genesis data hash from peer: " +
                verifiedPeer.connection.string +
                " response=" +
                showPeerValue(JSON.stringify(res)),
        )
    }

    await warnOnForkScheduleMismatch(verifiedPeer)
}

/**
 * The fork schedule is not part of what peers compare when they pair, so
 * pairing does not catch a node that missed the genesis edit. Compare it here
 * and say so loudly; never refuse to boot over it, because during a rolling
 * genesis edit peers legitimately disagree for a while. A peer that has not
 * loaded its own genesis yet answers "not ready"; that is retried and then left
 * to the periodic comparison (forkScheduleWatch.ts), not reported as a mismatch.
 * A different gasFeeSeparation treasury splits the nodes at once rather than
 * at a later height, so it starts a watch round now, which leaves the peer out
 * of the shard (or this node out of consensus) as a mismatch inside the window
 * would.
 */
async function warnOnForkScheduleMismatch(peer: Peer) {
    const ours = localScheduleView(
        getSharedState.forkConfig as unknown as ForkConfigLike,
        getSharedState.chainId,
    )
    const result = await checkPeerSchedule(peer, ours)
    switch (result.status) {
        case "mismatch":
            log.error(
                "[BOOTSTRAP] FORK SCHEDULE MISMATCH with " +
                    peer.connection.string +
                    ": " +
                    result.lines.join("; ") +
                    ". This node will split from its peers at the first activation height that differs. " +
                    `Fix the forks entries and properties.id in ${genesisFilePath()} and restart.`,
            )
            if (result.treasuryDiffers) {
                log.error(
                    "[BOOTSTRAP] gasFeeSeparation TREASURY MISMATCH with " +
                        peer.connection.string +
                        ": fees are credited to different accounts from the first block, so the two " +
                        "nodes cannot agree on any block that carries a fee",
                )
                void requestScheduleCheck()
            }
            break
        case "skipped":
            log.debug(
                "[BOOTSTRAP] Peer " +
                    peer.connection.string +
                    " reports no fork schedule; not compared",
            )
            break
        case "not-ready":
            log.warn(
                "[BOOTSTRAP] Peer " +
                    peer.connection.string +
                    " has not loaded its fork schedule yet; it will be compared later",
            )
            break
        case "unreachable":
            log.warn(
                "[BOOTSTRAP] Could not compare fork schedules with " +
                    peer.connection.string +
                    ": " +
                    result.reason,
            )
            break
        default:
            break
    }
}

/**
 * Runs the genesis checks on a paired anchor. Throws AnchorRefusal when they
 * fail, and GenesisCheckUnavailable when they could not be completed.
 */
async function confirmAnchorGenesis(verifiedPeer: Peer) {
    log.info("[BOOTSTRAP] OK: Valid peer " + verifiedPeer.connection.string)
    try {
        await ensureGenesisDataMatch(verifiedPeer)
    } catch (error) {
        if (error instanceof GenesisCheckUnavailable) {
            log.warning(`[BOOTSTRAP] Genesis check of ${verifiedPeer.connection.string} not done yet: ${error.message}`)
            throw error
        }
        peerman.removeOnlinePeer(verifiedPeer.identity)
        log.error("[BOOTSTRAP] Error ensuring genesis data match: " + error)
        throw new AnchorRefusal(
            `Genesis data match failed for peer ${verifiedPeer.connection.string}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

const pairingDeps: AnchorPairingDeps = {
    sayHello: peer => PeerManager.sayHelloToPeer(peer, true),
    isPaired: identity => peerman.getPeers().some(p => p.identity === identity),
    sleep,
}

export interface PeerBootstrapOptions {
    /**
     * Called when an anchor that did not answer at boot later refuses this
     * node. `fatal` is true while no anchor has confirmed this node yet: the
     * caller must then stop it, as bootstrap would have.
     */
    onLateRefusal?: (peer: Peer, refusal: Error, fatal: boolean) => void
}

let deferredChecks: DeferredAnchorChecks | null = null

/** Anchors that did not answer at boot and have not been checked yet. */
export function pendingAnchorIdentities(): string[] {
    return deferredChecks?.pendingIdentities ?? []
}

export function stopDeferredAnchorChecks() {
    deferredChecks?.stop()
    deferredChecks = null
}

function startDeferredAnchorChecks(
    anchors: Peer[],
    confirmed: boolean,
    options: PeerBootstrapOptions,
): DeferredAnchorChecks {
    stopDeferredAnchorChecks()
    const checks = new DeferredAnchorChecks(
        anchors,
        {
            ...pairingDeps,
            sayHello: peer => PeerManager.sayHelloToPeer(peer),
            confirm: confirmAnchorGenesis,
            now: () => Date.now(),
            onRefusal: (peer, refusal, fatal) => {
                if (fatal) {
                    log.error(
                        "[BOOTSTRAP] Refusing to continue: no anchor has confirmed this node and " +
                            `${peer.identity} @ ${peer.connection.string} refused it: ${refusal.message}`,
                    )
                } else {
                    peerman.refuseAnchor(peer.identity)
                    log.error(
                        `[BOOTSTRAP] Dropping anchor ${peer.identity} @ ${peer.connection.string} until this node restarts: ${refusal.message}`,
                    )
                }
                options.onLateRefusal?.(peer, refusal, fatal)
            },
        },
        getSharedState.genesisBlockHash,
        confirmed,
    )
    deferredChecks = checks
    void checks.run().catch(error =>
        log.error(
            "[BOOTSTRAP] Deferred anchor checks stopped: " +
                (error instanceof Error ? error.message : String(error)),
        ),
    )
    return checks
}

// ANCHOR Main function
export default async function peerBootstrap(
    localList: Peer[],
    options: PeerBootstrapOptions = {},
): Promise<Peer[]> {
    log.info("[BOOTSTRAP] Loading peers...")

    // INFO: Get our genesis data hash
    let genesisData: unknown
    try {
        genesisData = JSON.parse(fs.readFileSync(genesisFilePath(), "utf8"))
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const label =
            (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "Missing genesis file"
                : "Corrupt genesis file"
        throw new Error(`${label} at ${genesisFilePath()}: ${msg}`)
    }
    // Before anything is judged against the stored block 0: a refusal from an
    // earlier boot means that block is the one that was refused.
    const refusal = pendingRefusal(refusalMarkerFile, await storedGenesisHash())
    if (refusal) {
        log.error("[BOOTSTRAP] Refusing to continue: " + refusal)
        throw new Error(refusal)
    }
    // Kept after boot: anchors that come up later are checked against the same baseline.
    discoveredGenesisDataHashes.clear()
    ourGenesisDataHash = hashGenesisData(genesisData)
    ourGenesisCoreHash = hashGenesisCore(genesisData)

    const anchors = localList
        .filter(peer => peer.identity !== getSharedState.publicKeyHex)
        .map(peer => new Peer(peer.connection.string, peer.identity))
    for (const peer of anchors) {
        log.debug("[BOOTSTRAP] Attempting connection to: " + peer.connection.string)
    }

    const { paired, unreachable } = await pairAnchorsAtBoot(
        anchors,
        pairingDeps,
        getSharedState.genesisBlockHash,
    )
    const confirmed: Peer[] = []
    for (const peer of paired) {
        try {
            await confirmAnchorGenesis(peer)
            confirmed.push(peer)
        } catch (error) {
            if (!(error instanceof GenesisCheckUnavailable)) throw error
            unreachable.push(peer)
        }
    }

    if (unreachable.length > 0) {
        log.warning(
            `[BOOTSTRAP] ${unreachable.length} of ${anchors.length} anchors did not answer or could not be checked; ` +
                "continuing and running the bootstrap checks on each once it answers: " +
                unreachable.map(p => `${p.identity} @ ${p.connection.string}`).join(", "),
        )
        startDeferredAnchorChecks(unreachable, confirmed.length > 0, options)
    }

    log.info("[BOOTSTRAP] Valid peers found: " + peerman.getPeers().length)
    return peerman.getPeers()
}
