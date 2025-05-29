import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit, Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import ensureGCRForUser from "./ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import { SavedXmIdentity } from "@/model/entities/types/IdentityTypes"

import log from "@/utilities/logger"

export default class GCRIdentityRoutines {
    // SECTION XM Identity Routines
    static async applyXmIdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { chain, isEVM, subchain, targetAddress } = editOperation.data

        if (
            !chain ||
            !subchain ||
            typeof isEVM !== "boolean" ||
            !targetAddress
        ) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.xm[chain] = accountGCR.identities.xm[chain] || {}
        accountGCR.identities.xm[chain][subchain] =
            accountGCR.identities.xm[chain][subchain] || []

        const addressExists = accountGCR.identities.xm[chain][subchain].some(
            (id: SavedXmIdentity) =>
                isEVM
                    ? id.address.toLowerCase() === normalizedAddress
                    : id.address === normalizedAddress,
        )

        if (addressExists) {
            return { success: false, message: "Identity already exists" }
        }

        const data = {
            address: normalizedAddress,
            signature: editOperation.data.signature,
            publicKey: editOperation.data.publicKey || "",
            timestamp: editOperation.data.timestamp,
        }

        accountGCR.identities.xm[chain][subchain].push(data)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "Identity applied" }
    }

    static async applyXmIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { chain, isEVM, subchain, targetAddress } = editOperation.data

        if (!chain || !subchain || !targetAddress) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (
            !accountGCR.identities ||
            !accountGCR.identities.xm ||
            !accountGCR.identities.xm[chain] ||
            !Array.isArray(accountGCR.identities.xm[chain][subchain])
        ) {
            return {
                success: false,
                message: "No identities found for the specified chain/subchain",
            }
        }

        const addressExists = accountGCR.identities.xm[chain][subchain].some(
            (addr: SavedXmIdentity) =>
                isEVM
                    ? addr.address.toLowerCase() === normalizedAddress
                    : addr.address === normalizedAddress,
        )

        if (!addressExists) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.xm[chain][subchain] = accountGCR.identities.xm[
            chain
        ][subchain].filter((id: SavedXmIdentity) =>
            isEVM
                ? id.address.toLowerCase() !== normalizedAddress
                : id.address !== normalizedAddress,
        )

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "Identity removed" }
    }

    // SECTION Web2 Identity Routines
    static async applyWeb2IdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, data } = editOperation.data as Web2GCRData
        const accountGCR = await ensureGCRForUser(editOperation.account)
        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.username === data.username,
        )

        if (exists) {
            return { success: false, message: "Identity already exists" }
        }

        const proofOk = Hashing.sha256(data.proof) === data.proofHash

        if (!proofOk) {
            return {
                success: false,
                message:
                    "Sha256 proof mismatch: Expected " +
                    data.proofHash +
                    " but got " +
                    Hashing.sha256(data.proof),
            }
        }

        accountGCR.identities.web2[context].push(data)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "Web2 identity added" }
    }

    static async applyWeb2IdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, username } = editOperation.data
        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.username === username,
        )

        if (!exists) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.web2[context] = accountGCR.identities.web2[
            context
        ].filter((id: Web2GCRData["data"]) => id.username !== username)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "Web2 identity removed" }
    }

    // SECTION PQC Identity Routines
    static async applyPqcIdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const identities = editOperation.data

        if (!Array.isArray(identities)) {
            return {
                success: false,
                message: "Invalid edit operation data: expected array",
            }
        }

        const accountGCR = await ensureGCRForUser(editOperation.account)
        accountGCR.identities.pqc = accountGCR.identities.pqc || {}

        for (const identity of identities) {
            const { algorithm, address, signature } = identity

            if (!algorithm || !address || !signature) {
                return {
                    success: false,
                    message:
                        "Invalid identity data: missing algorithm, address or signature",
                }
            }

            accountGCR.identities.pqc[algorithm] =
                accountGCR.identities.pqc[algorithm] || []

            const keyExists = accountGCR.identities.pqc[algorithm].some(
                (key: { address: string; signature: string }) =>
                    key.address === address,
            )

            if (keyExists) {
                return {
                    success: false,
                    message: `Identity already exists for algorithm ${algorithm}`,
                }
            }

            accountGCR.identities.pqc[algorithm].push({ address, signature })
        }

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "PQC identities added" }
    }

    static async applyPqcIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const identities = editOperation.data

        if (!Array.isArray(identities)) {
            return {
                success: false,
                message: "Invalid edit operation data: expected array",
            }
        }

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (!accountGCR.identities || !accountGCR.identities.pqc) {
            return {
                success: false,
                message: "No PQC identities found",
            }
        }

        for (const identity of identities) {
            const { algorithm, address } = identity

            if (!algorithm || !address) {
                return {
                    success: false,
                    message:
                        "Invalid identity data: missing algorithm or address",
                }
            }

            if (
                !accountGCR.identities.pqc[algorithm] ||
                !Array.isArray(accountGCR.identities.pqc[algorithm])
            ) {
                return {
                    success: false,
                    message: `No PQC identities found for algorithm ${algorithm}`,
                }
            }

            const keyExists = accountGCR.identities.pqc[algorithm].some(
                (key: { address: string; signature: string }) =>
                    key.address === address,
            )

            if (!keyExists) {
                return {
                    success: false,
                    message: `Identity not found for algorithm ${algorithm}`,
                }
            }

            accountGCR.identities.pqc[algorithm] = accountGCR.identities.pqc[
                algorithm
            ].filter(
                (key: { address: string; signature: string }) =>
                    key.address !== address,
            )
        }

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "PQC identities removed" }
    }

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
            operation = operation === "add" ? "remove" : "add"
        }

        let result: GCRResult

        // CONVERT operation.account to hex
        identityEdit.account =
            typeof identityEdit.account === "string"
                ? identityEdit.account
                : forgeToHex(identityEdit.account)

        switch (identityEdit.context + operation) {
            case "xmadd":
                result = await this.applyXmIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "xmremove":
                result = await this.applyXmIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2add":
                result = await this.applyWeb2IdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2remove":
                result = await this.applyWeb2IdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pqcadd":
                result = await this.applyPqcIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pqcremove":
                result = await this.applyPqcIdentityRemove(
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

        return result
    }
}
