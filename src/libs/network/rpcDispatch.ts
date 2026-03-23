import {
    BrowserRequest,
    BundleContent,
    RPCRequest,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "../peer"
import ServerHandlers from "./endpointHandlers"
import { AuthMessage, manageAuth } from "./manageAuth"
import manageConsensusRoutines from "./manageConsensusRoutines"
import manageGCRRoutines from "./manageGCRRoutines"
import { manageExecution } from "./manageExecution"
import { HelloPeerRequest, manageHelloPeer } from "./manageHelloPeer"
import { handleLoginRequest, handleLoginResponse } from "./manageLogin"
import { manageNodeCall, NodeCall } from "./manageNodeCall"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import manageBridges from "./manageBridge"
import { bridge } from "@kynesyslabs/demosdk"
import { manageNativeBridge } from "./manageNativeBridge"
import { RateLimiter } from "./middleware/rateLimiter"
import GCR, { AccountParams } from "../blockchain/gcr/gcr"
import { ProofVerifier } from "@/features/zk/proof/ProofVerifier"
import Datasource from "@/model/datasource"
import type { IdentityAttestationProof } from "@/features/zk/proof/ProofVerifier"
import { getTransactionFinality } from "@/libs/consensus/petri/finality/transactionFinality"

// Protected endpoints requiring SUDO access
const PROTECTED_ENDPOINTS = new Set([
    "rate-limit/unblock",
    "getCampaignData",
    "awardPoints",
])

export const emptyResponse: RPCResponse = {
    result: 0,
    response: "",
    require_reply: false,
    extra: null,
}

export const postSchema = {
    body: {
        type: "object",
        required: ["method", "params"],
        properties: {
            method: { type: "string" },
            params: { type: "array" },
        },
    },
}

export function isRPCRequest(obj: any): obj is RPCRequest {
    return (
        typeof obj === "object" &&
        obj !== null &&
        "method" in obj &&
        typeof obj.method === "string" &&
        "params" in obj &&
        Array.isArray(obj.params)
    )
}

export async function processPayload(
    payload: RPCRequest,
    sender: string,
): Promise<RPCResponse> {
    const splits = sender.split(":")
    if (splits.length > 1) {
        sender = splits[1]
    }

    PeerManager.getInstance().updatePeerLastSeen(sender)

    if (PROTECTED_ENDPOINTS.has(payload.method)) {
        if (sender !== getSharedState.SUDO_PUBKEY) {
            return {
                result: 401,
                response: "Unauthorized sender",
                require_reply: false,
                extra: null,
            }
        }
    }

    switch (payload.method) {
        case "ping":
            return {
                result: 200,
                response: "pong",
                require_reply: false,
                extra: null,
            }
        case "execute":
            return await manageExecution(
                payload.params[0] as BundleContent,
                sender,
            )
        case "nativeBridge":
            return await manageNativeBridge(
                payload.params[0] as bridge.NativeBridgeOperation,
            )
        case "hello_peer": {
            const helloPeerRequest = payload.params[0] as HelloPeerRequest
            return await manageHelloPeer(
                helloPeerRequest as HelloPeerRequest,
                sender,
            )
        }
        case "mempool": {
            log.info(
                `[RPC Call] Received mempool merge request from: ${sender}`,
            )
            const res = await ServerHandlers.handleMempool(payload.params)
            log.info(`[RPC Call] Merged mempool from: ${sender}`)
            log.info(JSON.stringify(res))
            return res
        }
        case "peerlist":
            return await ServerHandlers.handlePeerlist(payload.params[0])
        case "auth":
            return await manageAuth(payload.params[0] as AuthMessage)
        case "nodeCall": {
            try {
                return await manageNodeCall(payload.params[0] as NodeCall)
            } catch (error) {
                log.error(`[RPC Call] Error in nodeCall: ${error}`)
                return {
                    result: 500,
                    response: "Error in nodeCall: ",
                    require_reply: false,
                    extra: {
                        error: error.toString(),
                    },
                }
            }
        }
        case "login_request":
            return await handleLoginRequest(payload.params[0] as BrowserRequest)
        case "login_response":
            return await handleLoginResponse(
                payload.params[0] as BrowserRequest,
            )

        case "consensus_routine": {
            return await manageConsensusRoutines(sender, payload.params[0])
        }

        case "gcr_routine":
            return await manageGCRRoutines(sender, payload.params[0])

        case "bridge":
            return await manageBridges(sender, payload.params[0])

        case "web2ProxyRequest": {
            const params = parseWeb2ProxyRequest(payload.params[0])
            return await handleWeb2ProxyRequest(params)
        }

        case "rate-limit/unblock": {
            const ips = payload.params

            if (!Array.isArray(ips)) {
                return {
                    result: 400,
                    response: "Invalid input. Expected an array of strings.",
                    require_reply: false,
                    extra: null,
                }
            }

            const results = RateLimiter.getInstance().unblockIP(ips)

            return {
                result: 200,
                response: {
                    message: "Rate limit unblock processed",
                    results,
                },
                require_reply: false,
                extra: null,
            }
        }

        case "getCampaignData": {
            return {
                result: 200,
                response: await GCR.getCampaignData(),
                require_reply: false,
                extra: null,
            }
        }

        case "awardPoints": {
            const firstParam = payload.params?.[0]
            if (!firstParam?.message) {
                return {
                    result: 400,
                    response: { error: "Invalid params: missing message" },
                    require_reply: false,
                    extra: null,
                }
            }
            const awardPointsData = firstParam.message as AccountParams[]
            const awardedAccounts = await GCR.awardPoints(awardPointsData)

            return {
                result: 200,
                response: {
                    awardedAccounts,
                },
                require_reply: false,
                extra: null,
            }
        }

        case "verifyProof": {
            try {
                const attestation = payload.params[0] as IdentityAttestationProof

                if (
                    !attestation.proof ||
                    !attestation.publicSignals ||
                    !Array.isArray(attestation.publicSignals) ||
                    attestation.publicSignals.length < 2
                ) {
                    return {
                        result: 400,
                        response: "Invalid proof format: missing proof or insufficient public signals",
                        require_reply: false,
                        extra: null,
                    }
                }

                const db = await Datasource.getInstance()
                const dataSource = db.getDataSource()
                const verifier = new ProofVerifier(dataSource)

                const isUsed = await verifier.isNullifierUsed(attestation.publicSignals[0])
                if (isUsed) {
                    return {
                        result: 200,
                        response: {
                            valid: false,
                            reason: "Nullifier already used",
                            nullifier: attestation.publicSignals[0],
                            merkleRoot: attestation.publicSignals[1],
                        },
                        require_reply: false,
                        extra: null,
                    }
                }

                const isValid = await ProofVerifier.verifyProofOnly(
                    attestation.proof,
                    attestation.publicSignals,
                )

                return {
                    result: isValid ? 200 : 400,
                    response: {
                        valid: isValid,
                        reason: isValid ? "Valid proof" : "Invalid cryptographic proof",
                        nullifier: attestation.publicSignals[0],
                        merkleRoot: attestation.publicSignals[1],
                    },
                    require_reply: false,
                    extra: null,
                }
            } catch (error) {
                log.error("[ZK RPC] Error verifying proof:", error)
                return {
                    result: 500,
                    response: "Internal server error",
                    require_reply: false,
                    extra: null,
                }
            }
        }

        // REVIEW: Petri Consensus — transaction finality query (Phase 5)
        case "getTransactionFinality": {
            const txHash = payload.params?.[0] as string
            if (!txHash || typeof txHash !== "string") {
                return {
                    result: 400,
                    response: "Missing or invalid transaction hash",
                    require_reply: false,
                    extra: null,
                }
            }
            const finality = await getTransactionFinality(txHash)
            return {
                result: 200,
                response: finality,
                require_reply: false,
                extra: null,
            }
        }

        default:
            log.warning(
                "[RPC Call] [Received] Method not found: " + payload.method,
            )
            return {
                result: 501,
                response: "Method not implemented: " + payload.method,
                require_reply: false,
                extra: null,
            }
    }
}
