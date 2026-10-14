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
import { resolveGenesisMismatch } from "./genesisMismatch"
import {
    checkPeerSchedule,
    localScheduleView,
    type ForkConfigLike,
} from "./forkScheduleAgreement"

let ourGenesisDataHash = ""
let ourGenesisCoreHash = ""
const genesisFile = "data/genesis.json"
const peerman = PeerManager.getInstance()
const discoveredGenesisDataHashes = new Set<string>()

async function ensureGenesisDataMatch(verifiedPeer: Peer) {
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
        log.debug("[BOOTSTRAP] Genesis data hash: " + JSON.stringify(res))

        if (res?.result === 200) {
            break
        }

        if (attempt < maxAttempts) {
            log.warn(
                `[BOOTSTRAP] Peer ${verifiedPeer.connection.string} is not ready to serve genesis data hash yet ` +
                    `(attempt ${attempt}/${maxAttempts}, result=${res?.result})`,
            )
            await sleep(1000)
            continue
        }
    }

    if (res.result === 200) {
        const peerGenesisDataHash = res.response

        const verdict = await resolveGenesisMismatch(
            ourGenesisDataHash,
            ourGenesisCoreHash,
            peerGenesisDataHash,
            {
                fetchPeerGenesis: async () => {
                    log.warn(
                        "[BOOTSTRAP] Genesis data hash differs from the one " +
                            verifiedPeer.connection.string +
                            " advertises (ours " +
                            ourGenesisDataHash +
                            ", theirs " +
                            peerGenesisDataHash +
                            "); comparing the data it serves",
                    )
                    log.debug(
                        "[BOOTSTRAP] Fetching new genesis data from peer: " +
                            verifiedPeer.connection.string,
                    )
                    const served = await axios.get(
                        verifiedPeer.connection.string + "/genesis",
                    )
                    return served.status === 200 ? served.data : null
                },
                readLocalGenesis: () =>
                    JSON.parse(fs.readFileSync(genesisFile, "utf8")),
                writeGenesis: data =>
                    fs.writeFileSync(genesisFile, JSON.stringify(data, null, 2)),
                hashFull: hashGenesisData,
                hashCore: hashGenesisCore,
            },
        )

        if (verdict.outcome === "unhashed-fields-only") {
            log.warn(
                "[BOOTSTRAP] Peer " +
                    verifiedPeer.connection.string +
                    " serves genesis data that differs from ours only in the fork schedule or chain id; " +
                    "keeping our data/genesis.json as it is",
            )
        } else if (verdict.outcome === "replaced") {
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
    } else {
        log.error(
            "[BOOTSTRAP] Failed to get genesis data hash from peer: " +
                verifiedPeer.connection.string +
                " response=" +
                JSON.stringify(res),
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
                    " does not publish a fork schedule digest; not compared",
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
