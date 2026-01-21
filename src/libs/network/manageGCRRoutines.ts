import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import IdentityManager from "../blockchain/gcr/gcr_routines/identityManager"
import { emptyResponse } from "./server_rpc"
import { IncentiveManager } from "../blockchain/gcr/gcr_routines/IncentiveManager"
import ensureGCRForUser from "../blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Referrals } from "@/features/incentive/referrals"
import GCR from "../blockchain/gcr/gcr"
import { NomisIdentityProvider } from "@/libs/identity/providers/nomisIdentityProvider"
import { BroadcastManager } from "../communications/broadcastManager"
import { GCRStorageProgramRoutines } from "../blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import Datasource from "@/model/datasource"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"

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
                response.response =
                    await NomisIdentityProvider.listIdentities(sender)
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

        // SECTION StorageProgram Query Methods

        // REVIEW: Get storage program by address
        case "getStorageProgram": {
            const storageAddress = params[0]
            const requesterAddress = params[1] // Optional identity for ACL check

            if (!storageAddress) {
                response.result = 400
                response.response = null
                response.extra = { error: "Storage address is required" }
                break
            }

            try {
                const db = await Datasource.getInstance()
                const repository = db
                    .getDataSource()
                    .getRepository(GCRStorageProgram)

                const program =
                    await GCRStorageProgramRoutines.getStorageProgram(
                        storageAddress,
                        repository,
                    )

                if (!program) {
                    response.result = 404
                    response.response = null
                    response.extra = {
                        error: `Storage program not found: ${storageAddress}`,
                    }
                    break
                }

                // Check read permission
                const hasReadAccess =
                    GCRStorageProgramRoutines.checkReadPermission(
                        program,
                        requesterAddress,
                    )

                if (!hasReadAccess) {
                    response.result = 403
                    response.response = null
                    response.extra = {
                        error: "Permission denied: You do not have read access to this storage program",
                    }
                    break
                }

                response.response = {
                    storageAddress: program.storageAddress,
                    owner: program.owner,
                    programName: program.programName,
                    encoding: program.encoding,
                    data: program.data,
                    metadata: program.metadata,
                    storageLocation: program.storageLocation,
                    sizeBytes: program.sizeBytes,
                    createdAt: program.createdAt.toISOString(),
                    updatedAt: program.updatedAt.toISOString(),
                }
            } catch (error) {
                response.result = 500
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

        // REVIEW: Get storage programs by owner
        case "getStorageProgramsByOwner": {
            const owner = params[0]
            const requesterAddress = params[1] // Optional identity for ACL filtering

            if (!owner) {
                response.result = 400
                response.response = null
                response.extra = { error: "Owner address is required" }
                break
            }

            try {
                const db = await Datasource.getInstance()
                const repository = db
                    .getDataSource()
                    .getRepository(GCRStorageProgram)

                const programs =
                    await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                        owner,
                        repository,
                    )

                // Filter to only programs the requester can read
                const accessiblePrograms = programs.filter(program =>
                    GCRStorageProgramRoutines.checkReadPermission(
                        program,
                        requesterAddress,
                    ),
                )

                // Map to response format (without full data for list view)
                response.response = accessiblePrograms.map(p => ({
                    storageAddress: p.storageAddress,
                    programName: p.programName,
                    encoding: p.encoding,
                    sizeBytes: p.sizeBytes,
                    storageLocation: p.storageLocation,
                    createdAt: p.createdAt.toISOString(),
                    updatedAt: p.updatedAt.toISOString(),
                }))
            } catch (error) {
                response.result = 500
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

        // REVIEW: Search storage programs by name
        case "searchStoragePrograms": {
            const query = params[0]
            const options = params[1] || {} // { limit, offset, exactMatch }
            const requesterAddress = params[2] // Optional identity for ACL filtering

            if (!query || (typeof query === "string" && query.trim() === "")) {
                response.result = 400
                response.response = null
                response.extra = { error: "Search query is required" }
                break
            }

            try {
                const db = await Datasource.getInstance()
                const repository = db
                    .getDataSource()
                    .getRepository(GCRStorageProgram)

                const programs =
                    await GCRStorageProgramRoutines.searchStorageProgramsByName(
                        typeof query === "string"
                            ? query.trim()
                            : String(query),
                        repository,
                        {
                            limit: options.limit || 50,
                            offset: options.offset || 0,
                            exactMatch: options.exactMatch || false,
                        },
                    )

                // Filter to only programs the requester can read
                const accessiblePrograms = programs.filter(program =>
                    GCRStorageProgramRoutines.checkReadPermission(
                        program,
                        requesterAddress,
                    ),
                )

                // Map to response format (without full data for list view)
                response.response = accessiblePrograms.map(p => ({
                    storageAddress: p.storageAddress,
                    programName: p.programName,
                    encoding: p.encoding,
                    sizeBytes: p.sizeBytes,
                    storageLocation: p.storageLocation,
                    createdAt: p.createdAt.toISOString(),
                    updatedAt: p.updatedAt.toISOString(),
                }))
            } catch (error) {
                response.result = 500
                response.response = null
                response.extra = {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            }
            break
        }

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
