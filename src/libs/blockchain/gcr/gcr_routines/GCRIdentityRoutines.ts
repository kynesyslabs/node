// TODO GCREditIdentity but typed as any due to union type constraints <- we have a lot of editOperations marked as any. Why is that? Should we standardize the identity operation types?

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import {
    applyXmIdentityAdd,
    applyXmIdentityRemove,
    applyWeb2IdentityAdd,
    applyWeb2IdentityRemove,
    applyPqcIdentityAdd,
    applyPqcIdentityRemove,
    applyUdIdentityAdd,
    applyUdIdentityRemove,
    applyAwardPoints,
    applyAwardPointsRollback,
    applyZkCommitmentAdd,
    applyZkAttestationAdd,
    applyNomisIdentityUpsert,
    applyNomisIdentityRemove,
    applyHumanPassportIdentityAdd,
    applyHumanPassportIdentityRemove,
    applyEthosIdentityUpsert,
    applyEthosIdentityRemove,
    applyTLSNIdentityAdd,
    applyTLSNIdentityRemove,
} from "./routines"

export default class GCRIdentityRoutines {
    static async apply(
        editOperation: GCREdit,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (
            editOperation.type !== "identity" ||
            !("context" in editOperation)
        ) {
            return {
                success: false,
                message: "Invalid edit operation for identity routine",
            }
        }

        const identityEdit = structuredClone(editOperation)

        let operation = identityEdit.operation
        if (identityEdit.isRollback) {
            if (operation === "add") {
                operation = "remove"
            } else if (operation === "remove") {
                operation = "add"
            }
        }

        let result: GCRResult

        // CONVERT operation.account to hex
        identityEdit.account =
            typeof identityEdit.account === "string"
                ? identityEdit.account
                : forgeToHex(identityEdit.account)

        switch (operation) {
            case "zk_commitmentadd":
                result = await applyZkCommitmentAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "zk_attestationadd":
                result = await applyZkAttestationAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            default:
                switch (identityEdit.context + operation) {
            case "xmadd":
                result = await applyXmIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "xmremove":
                result = await applyXmIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2add":
                result = await applyWeb2IdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2remove":
                result = await applyWeb2IdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pqcadd":
                result = await applyPqcIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pqcremove":
                result = await applyPqcIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "udadd":
                result = await applyUdIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "udremove":
                result = await applyUdIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pointsadd":
                result = await applyAwardPoints(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pointsremove":
                result = await applyAwardPointsRollback(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "nomisadd":
                result = await applyNomisIdentityUpsert(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "zk_commitmentadd":
                result = await applyZkCommitmentAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "nomisremove":
                result = await applyNomisIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "humanpassportadd":
                result = await applyHumanPassportIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "humanpassportremove":
                result = await applyHumanPassportIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "ethosadd":
                result = await applyEthosIdentityUpsert(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "ethosremove":
                result = await applyEthosIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "tlsnadd":
                result = await applyTLSNIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break

            case "tlsnremove":
                result = await applyTLSNIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            default:
                result = {
                    success: false,
                    message: "Unsupported identity operation",
                }
                }
        }

        return result
    }
}
