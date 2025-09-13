import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import IdentityManager from "../blockchain/gcr/gcr_routines/identityManager"
import { emptyResponse } from "./server_rpc"
import { IncentiveManager } from "../blockchain/gcr/gcr_routines/IncentiveManager"
import ensureGCRForUser from "../blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Referrals } from "@/features/incentive/referrals"
import GCR from "../blockchain/gcr/gcr"

interface GCRRoutinePayload {
    method: string
    params: any[] // ? Define the params type or nah
}

export default async function manageGCRRoutines(
    sender: string,
    payload: GCRRoutinePayload,
): Promise<RPCResponse> {
    const response = _.cloneDeep(emptyResponse)
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

        case "getPoints":
            response.response = await IncentiveManager.getPoints(params[0])
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

        case "getAccountByTwitterUsername": {
            const username = params[0]

            if (!username) {
                response.result = 400
                response.response = "No username specified"
                break
            }

            response.response = await GCR.getAccountByTwitterUsername(username)
            break
        }

        case "getAccountByTelegramUsername": {
            const username = params[0]

            if (!username) {
                response.result = 400
                response.response = "No username specified"
                break
            }

            response.response = await GCR.getAccountByTelegramUsername(username)
            break
        }

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
