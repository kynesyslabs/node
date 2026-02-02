import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import IdentityManager from "../blockchain/gcr/gcr_routines/identityManager"
import { emptyResponse } from "./server_rpc"
import { IncentiveManager } from "../blockchain/gcr/gcr_routines/IncentiveManager"
import ensureGCRForUser from "../blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Referrals } from "@/features/incentive/referrals"
import GCR from "../blockchain/gcr/gcr"
import { NomisIdentityProvider } from "@/libs/identity/providers/nomisIdentityProvider"
import HumanPassportProvider from "@/libs/identity/tools/humanpassport"
import { BroadcastManager } from "../communications/broadcastManager"

interface GCRRoutinePayload {
    method: string
    params: any[] // ? Define the params type or nah
}

export default async function manageGCRRoutines(
    sender: string,
    payload: GCRRoutinePayload,
): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
    response.result = 200
    // Handle the payload
    const { method, params } = payload

    switch (method) {
        // SECTION XM Identity Management

        case "identity_assign_from_write":
            response.response = await IdentityManager.inferIdentityFromWrite(
                params[0],
            )
            break

        case "getIdentities":
            response.response = await IdentityManager.getIdentities(params[0])
            break

        case "getWeb2Identities":
            response.response = await IdentityManager.getIdentities(
                params[0],
                "web2",
            )
            break

        case "getXmIdentities":
            response.response = await IdentityManager.getIdentities(
                params[0],
                "xm",
            )
            break

        case "getUDIdentities":
            response.response = await IdentityManager.getIdentities(
                params[0],
                "ud",
            )
            break

        case "getPoints":
            response.response = await IncentiveManager.getPoints(params[0])
            break

        case "getTopAccountsByPoints":
            response = await GCR.getTopAccountsByPoints()
            break

        case "getReferralInfo": {
            const account = await ensureGCRForUser(params[0])
            response.response = account.referralInfo
            break
        }

        case "validateReferralCode": {
            const account = await Referrals.findAccountByReferralCode(params[0])
            response.response = {
                isValid: account !== null,
                referrerPubkey: account?.pubkey || null,
                message: account
                    ? "Referral code is valid"
                    : "Referral code is invalid",
            }
            break
        }

        case "getAccountByIdentity": {
            const identity = params[0]

            if (!identity) {
                response.result = 400
                response.response = null
                response.extra = { error: "No identity specified" }
                break
            }

            response.response = await GCR.getAccountByIdentity(identity)
            break
        }

        case "getNomisScore": {
            const options = params[0]

            if (!options?.walletAddress) {
                response.result = 400
                response.response = null
                response.extra = { error: "walletAddress is required" }
                break
            }

            try {
                response.response = await NomisIdentityProvider.getWalletScore(
                    sender,
                    options.walletAddress,
                    {
                        chain: options.chain,
                        subchain: options.subchain,
                        scoreType: options.scoreType,
                        nonce: options.nonce,
                        deadline: options.deadline,
                    },
                )
            } catch (error) {
                response.result = 400
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

        case "getNomisIdentities": {
            try {
                response.response = await NomisIdentityProvider.listIdentities(
                    sender,
                )
            } catch (error) {
                response.result = 400
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

        case "getHumanPassportScore": {
            const options = params[0]

            // Support both positional (string) and object ({ address }) param styles
            const address =
                typeof options === "string" ? options : options?.address
            // Always force refresh to get latest score from API
            const forceRefresh = true

            if (!address) {
                response.result = 400
                response.response = null
                response.extra = { error: "address is required" }
                break
            }

            try {
                const provider = HumanPassportProvider.getInstance()
                response.response = await provider.verifyAddress(
                    address,
                    forceRefresh,
                )
            } catch (error) {
                response.result = 400
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

        case "getHumanPassportIdentities": {
            try {
                response.response =
                    await IdentityManager.getHumanPassportIdentities(sender)
            } catch (error) {
                response.result = 400
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

        case "syncNewBlock": {
            response.response = await BroadcastManager.handleNewBlock(
                sender,
                params[0],
            )
            break
        }

        case "updateSyncData": {
            response.response = await BroadcastManager.handleUpdatePeerSyncData(
                sender,
                params[0],
            )
            break
        }

        // case "getAccountByTelegramUsername": {
        //     const username = params[0]

        //     if (!username) {
        //         response.result = 400
        //         response.response = "No username specified"
        //         break
        //     }

        //     response.response = await GCR.getAccountByTelegramUsername(username)
        //     break
        // }

        // SECTION Web2 Identity Management

        default:
            response.response = false
            break
    }

    // Check if the response is valid
    if (response.response === false) {
        response.result = 400
        response.extra = "Payload failed to execute"
    }

    return response
}
