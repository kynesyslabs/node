// TODO GCREditIdentity but typed as any due to union type constraints <- we have a lot of editOperations marked as any. Why is that? Should we standardize the identity operation types?

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit } from "@kynesyslabs/demosdk/types"
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
        accountGCR: GCRMain,
        simulate?: boolean, // NEEDED by zk transactions
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
                    simulate,
                )
                break
            case "zk_attestationadd":
                result = await applyZkAttestationAdd(
                    identityEdit,
                    simulate,
                )
                break
            default:
                switch (identityEdit.context + operation) {
                    case "xmadd":
                        result = await applyXmIdentityAdd(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "xmremove":
                        result = await applyXmIdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "web2add":
                        result = await applyWeb2IdentityAdd(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "web2remove":
                        result = await applyWeb2IdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "pqcadd":
                        result = await applyPqcIdentityAdd(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "pqcremove":
                        result = await applyPqcIdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "udadd":
                        result = await applyUdIdentityAdd(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "udremove":
                        result = await applyUdIdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "pointsadd":
                        result = await applyAwardPoints(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "pointsremove":
                        result = await applyAwardPointsRollback(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "nomisadd":
                        result = await applyNomisIdentityUpsert(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "nomisremove":
                        result = await applyNomisIdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "humanpassportadd":
                        result = await applyHumanPassportIdentityAdd(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "humanpassportremove":
                        result = await applyHumanPassportIdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "ethosadd":
                        result = await applyEthosIdentityUpsert(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "ethosremove":
                        result = await applyEthosIdentityRemove(
                            identityEdit,
                            accountGCR,
                        )
                        break
                    case "tlsnadd":
                        result = await applyTLSNIdentityAdd(
                            identityEdit,
                            accountGCR,
                        )
                        break

                    case "tlsnremove":
                        result = await applyTLSNIdentityRemove(
                            identityEdit,
                            accountGCR,
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
