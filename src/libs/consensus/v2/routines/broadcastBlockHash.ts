import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { ConsensusHashResponse } from "../interfaces"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"

export async function broadcastBlockHash(
    block: Block,
    shard: Peer[],
): Promise<[number, number]> {
    let pro = 0
    let con = 0
    const ourId = getSharedState.publicKeyHex
    const proposeParams = [block.hash, block.validation_data, ourId]

    // Send proposeBlockHash to all shard peers in parallel
    const rpcPromises = shard.map(peer =>
        peer.longCall({
            method: "consensus_routine",
            params: [
                {
                    method: "proposeBlockHash",
                    params: proposeParams,
                },
            ],
        }),
    )

    // Await ALL RPC responses (allSettled so one peer failure doesn't abort all)
    const settled = await Promise.allSettled(rpcPromises)

    for (const result of settled) {
        if (result.status === "rejected") {
            log.error(`[broadcastBlockHash] RPC call rejected: ${result.reason}`)
            con++
            continue
        }
        const response = result.value
        log.info("[broadcastBlockHash] response from a validator received.")

        if (response.result === 200) {
            log.info(
                "[broadcastBlockHash] Block hash confirmation received from: " +
                    response.response,
            )

            // Verify and accumulate all incoming signatures
            const incomingSignatures: { [key: string]: string } =
                response.extra?.["signatures"] ?? {}

            for (const [identity, signature] of Object.entries(incomingSignatures)) {
                try {
                    const isValid = await ucrypto.verify({
                        algorithm: getSharedState.signingAlgorithm,
                        message: new TextEncoder().encode(block.hash),
                        signature: hexToUint8Array(signature),
                        publicKey: hexToUint8Array(identity),
                    })

                    if (isValid) {
                        block.validation_data.signatures[identity] = signature
                        log.debug(
                            `Signature from ${identity.substring(0, 16)}... verified and added`,
                        )
                    } else {
                        log.error(
                            `Invalid signature from ${identity.substring(0, 16)}... — not added`,
                        )
                    }
                } catch (e) {
                    log.error(
                        `Signature verification error for ${identity.substring(0, 16)}...: ${e}`,
                    )
                }
            }

            pro++
        } else {
            log.error(
                "[broadcastBlockHash] Block hash rejected by: " +
                    response.response,
            )
            log.error(
                "[broadcastBlockHash] Reason: " +
                    JSON.stringify(response.extra),
            )
            con++
        }
    }

    const signatureCount = Object.keys(
        block.validation_data.signatures,
    ).length

    log.info(
        `[broadcastBlockHash] Broadcast complete: ${signatureCount} signatures ` +
        `(pro=${pro}, con=${con})`,
    )

    return [signatureCount, shard.length - signatureCount]
}
