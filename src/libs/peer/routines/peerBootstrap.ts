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
import getPeerIdentity from "./getPeerIdentity"
import { sleep } from "@kynesyslabs/demosdk/utils"
import { RPCRequest } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { hashGenesisData } from "@/libs/blockchain/genesis/normalizeGenesisForHash"

let ourGenesisDataHash = ""
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

        if (peerGenesisDataHash !== ourGenesisDataHash) {
            log.error("[BOOTSTRAP] Genesis data hash does not match")
            log.warn(
                "[BOOTSTRAP] Expected: " +
                    ourGenesisDataHash +
                    " Got: " +
                    peerGenesisDataHash,
            )
            log.debug(
                "[BOOTSTRAP] Fetching new genesis data from peer: " +
                    verifiedPeer.connection.string,
            )

            const res = await axios.get(
                verifiedPeer.connection.string + "/genesis",
            )

            if (res.status === 200) {
                // INFO: Save the new genesis data to the file
                fs.writeFileSync(genesisFile, JSON.stringify(res.data, null, 2))
                // Re-hash through the canonical normalizer so connection_url
                // differences between this node and the source peer do not
                // produce a spurious mismatch (see normalizeGenesisForHash.ts).
                const ourNewGenesisDataHash = hashGenesisData(
                    JSON.parse(fs.readFileSync(genesisFile, "utf8")),
                )

                // INFO: Update discovered genesis hashes and current genesis hash
                discoveredGenesisDataHashes.add(ourNewGenesisDataHash)
                ourGenesisDataHash = ourNewGenesisDataHash

                // INFO: Ensure all peers have the same genesis data
                if (discoveredGenesisDataHashes.size > 1) {
                    log.error(
                        "[BOOTSTRAP] Conflicting genesis data hashes found",
                    )
                    throw new Error("Conflicting genesis data hashes found across peers")
                }

                log.debug(
                    "[BOOTSTRAP] Downloaded genesis data with hash: " +
                        ourNewGenesisDataHash,
                )

                if (ourNewGenesisDataHash !== peerGenesisDataHash) {
                    log.error(
                        "[BOOTSTRAP] New genesis data hash still does not match: " +
                            ourNewGenesisDataHash +
                            " != " +
                            peerGenesisDataHash,
                    )
                    throw new Error(`Genesis data hash mismatch after download: ${ourNewGenesisDataHash} != ${peerGenesisDataHash}`)
                }

                return
            }

            log.error(
                "[BOOTSTRAP] Failed to download genesis data from peer: " +
                    verifiedPeer.connection.string,
            )
            throw new Error(`Failed to download genesis data from peer: ${verifiedPeer.connection.string}`)
        }
    } else {
        log.error(
            "[BOOTSTRAP] Failed to get genesis data hash from peer: " +
                verifiedPeer.connection.string +
                " response=" +
                JSON.stringify(res),
        )
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
    const blankPeer = new Peer(currentPeerUrl, currentPublicKey)
    // Adding identity if any
    log.debug("[BOOTSTRAP] Testing " + currentPeerUrl + " identity")
    // After this, the peer object will have an identity and thus will be verified
    const verifiedPeer = await getPeerIdentity(blankPeer, currentPublicKey)
    if (!verifiedPeer) {
        log.warning(
            "[BOOTSTRAP] [FAILED] Failed to get peer identity: see above",
        )

        PeerManager.markPeerOffline(blankPeer)
        return
    }

    try {
        verifiedPeer.connection.string = currentPeerUrl // Adding this step
    } catch (error) {
        log.error("[BOOTSTRAP] Error setting connection string: " + error)
        log.critical("Error setting connection string: " + error)
        return
    }
    log.info("[BOOTSTRAP] OK: Valid peer " + currentPeerUrl)

    try {
        await ensureGenesisDataMatch(verifiedPeer)
    } catch (error) {
        log.error("[BOOTSTRAP] Error ensuring genesis data match: " + error)
        log.error("[PEER] Bootstrap error: " + error)
        throw new Error(`Genesis data match failed for peer ${verifiedPeer.connection.string}: ${error instanceof Error ? error.message : String(error)}`)
    }

    let maxRetries = 3
    while (maxRetries > 0) {
        // INFO: Check if peer's genesis hash matches ours, else download their genesis data
        await PeerManager.sayHelloToPeer(verifiedPeer, true)

        // INFO: Confirmed we paired with anchor node
        if (
            peerman.getPeers().find(p => p.identity === verifiedPeer.identity)
        ) {
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

    // Validity check
    for (const peer of localList) {
        await tryConnectPeer(peer)
    }

    ourGenesisDataHash = null
    discoveredGenesisDataHashes.clear()

    log.info("[BOOTSTRAP] Valid peers found: " + peerman.getPeers().length)
    return peerman.getPeers()
}
