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
import { Config } from "src/config"
import { replaceFileAtomically } from "./replaceFileAtomically"
import {
    clearRefusalMarker,
    pendingRefusal,
    writeRefusalMarker,
} from "./genesisRefusalMarker"

let ourGenesisDataHash = ""
let ourGenesisCoreHash = ""
const genesisFile = "data/genesis.json"
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
    const served = await axios.get(verifiedPeer.connection.string + "/genesis", {
        timeout: GENESIS_DOWNLOAD_TIMEOUT_MS,
        maxContentLength: MAX_GENESIS_BYTES,
        maxBodyLength: MAX_GENESIS_BYTES,
    })
    return served.status === 200 ? served.data : null
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
                "keeping our data/genesis.json as it is",
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
                "our data/genesis.json",
        )
        return
    }
    if (verdict.outcome !== "replaced") return

    log.warn(
        "[BOOTSTRAP] Replaced data/genesis.json with the data served by " +
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
        genesisFile,
        JSON.stringify(data, null, 2),
        written => {
            if (hashGenesisCore(JSON.parse(written)) !== expectedCoreHash) {
                throw new Error(
                    "Genesis data written from peer does not hash like what the peer served",
                )
            }
        },
    )
    log.debug(`[BOOTSTRAP] Replaced ${genesisFile} (${method})`)
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
                    JSON.parse(fs.readFileSync(genesisFile, "utf8")),
                writeGenesis: writeGenesisAtomically,
                hashFull: hashGenesisData,
                hashCore: hashGenesisCore,
            },
            {
                storedHash,
                expectedHash: Config.getInstance().core.expectedGenesisHash,
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
        log.error(
            "[BOOTSTRAP] Failed to get genesis data hash from peer: " +
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
                    "Fix the forks entries and properties.id in data/genesis.json and restart.",
            )
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

async function tryConnectPeer(peer: Peer) {
    if (peer.identity === getSharedState.publicKeyHex) {
        return
    }

    log.debug("[BOOTSTRAP] Attempting connection to: " + peer.connection.string)
    // ANCHOR Extract peer info from the string
    // If there is a : in the url, we assume it's a address + port
    const currentPeerUrl: string = peer.connection.string
    const currentPublicKey: string = peer.identity
    log.debug(
        "[BOOTSTRAP] Testing " +
            currentPeerUrl +
            " with id " +
            currentPublicKey,
    )
    // ANCHOR Connection test and hello_peer routine
    // The signed hello reply proves the key answers at this URL; the reply
    // verification in helloPeerCallback adds the peer only when it does.
    const verifiedPeer = new Peer(currentPeerUrl, currentPublicKey)

    let maxRetries = 3
    while (maxRetries > 0) {
        const verdict = await PeerManager.sayHelloToPeer(verifiedPeer, true)

        if (verdict === "unsigned") {
            throw new Error(
                `Anchor ${verifiedPeer.identity} @ ${currentPeerUrl} answered without a signed hello: it runs pre-signature code. Pick an up-to-date anchor.`,
            )
        }
        if (verdict === "invalid") {
            throw new Error(
                `Anchor ${verifiedPeer.identity} @ ${currentPeerUrl} failed identity verification: the URL is not served by that key.`,
            )
        }

        // INFO: Confirmed we paired with anchor node
        if (
            verdict === "verified" &&
            peerman.getPeers().find(p => p.identity === verifiedPeer.identity)
        ) {
            log.info("[BOOTSTRAP] OK: Valid peer " + currentPeerUrl)
            try {
                await ensureGenesisDataMatch(verifiedPeer)
            } catch (error) {
                peerman.removeOnlinePeer(verifiedPeer.identity)
                log.error("[BOOTSTRAP] Error ensuring genesis data match: " + error)
                log.error("[PEER] Bootstrap error: " + error)
                throw new Error(`Genesis data match failed for peer ${verifiedPeer.connection.string}: ${error instanceof Error ? error.message : String(error)}`)
            }
            return
        }

        log.warn("[BOOTSTRAP] Failed to pair with anchor node, retrying...")
        maxRetries--
        await sleep(1000)
    }

    log.error(
        "[BOOTSTRAP] Failed to pair with anchor peer: " +
            verifiedPeer.identity +
            " @ " +
            verifiedPeer.connection.string,
    )
    throw new Error(`Failed to pair with anchor peer: ${verifiedPeer.identity} @ ${verifiedPeer.connection.string}`)
}

// ANCHOR Main function
export default async function peerBootstrap(
    localList: Peer[],
): Promise<Peer[]> {
    log.info("[BOOTSTRAP] Loading peers...")

    // INFO: Get our genesis data hash
    const genesisFile = "data/genesis.json"
    let genesisData: unknown
    try {
        genesisData = JSON.parse(fs.readFileSync(genesisFile, "utf8"))
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const label =
            (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "Missing genesis file"
                : "Corrupt genesis file"
        throw new Error(`${label} at data/genesis.json: ${msg}`)
    }
    // Before anything is judged against the stored block 0: a refusal from an
    // earlier boot means that block is the one that was refused.
    const refusal = pendingRefusal(refusalMarkerFile, await storedGenesisHash())
    if (refusal) {
        log.error("[BOOTSTRAP] Refusing to continue: " + refusal)
        throw new Error(refusal)
    }
    ourGenesisDataHash = hashGenesisData(genesisData)
    ourGenesisCoreHash = hashGenesisCore(genesisData)

    // Validity check
    for (const peer of localList) {
        await tryConnectPeer(peer)
    }

    ourGenesisDataHash = null
    ourGenesisCoreHash = null
    discoveredGenesisDataHashes.clear()

    log.info("[BOOTSTRAP] Valid peers found: " + peerman.getPeers().length)
    return peerman.getPeers()
}
