import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool_v2"
import type { Transaction, L2PSTransaction } from "@kynesyslabs/demosdk/types"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import _ from "lodash"
import {
    ExecutionResult,
    ValidityData,
    XMScript,
    RPCResponse,
    IWeb2Payload,
    SigningAlgorithm,
} from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import isValidatorForNextBlock from "src/libs/consensus/v2/routines/isValidator"
import handleDemosWorkRequest from "./routines/transactions/demosWork/handleDemosWorkRequest"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import { DemoScript } from "@kynesyslabs/demosdk/types"
import HandleGCR from "../blockchain/gcr/handleGCR"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import handleIdentityRequest from "./routines/transactions/handleIdentityRequest"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { NativeBridgeOperationCompiled } from "@kynesyslabs/demosdk/bridge"
import handleNativeBridgeTx from "./routines/transactions/handleNativeBridgeTx"
import { DTRManager } from "./dtr/dtrmanager"
import handleL2PS from "./routines/transactions/handleL2PS"

function isReferenceBlockAllowed(referenceBlock: number, lastBlock: number) {
    return (
        referenceBlock >= lastBlock - getSharedState.referenceBlockRoom &&
        referenceBlock <= lastBlock
    )
}

export async function handleExecuteTransaction(
    validatedData: ValidityData,
    sender: string,
): Promise<ExecutionResult> {
    log.debug(
        "[handleExecuteTransaction] Validated Data: " +
        JSON.stringify(validatedData),
    )

    const fname = "[handleExecuteTransaction] "
    const result: ExecutionResult = {
        success: true,
        response: null,
        extra: null,
        require_reply: false,
    }

    const ourKey = (
        await ucrypto.getIdentity(getSharedState.signingAlgorithm)
    ).publicKey

    log.debug("Our key: " + ourKey)
    const hexOurKey = uint8ArrayToHex(ourKey as Uint8Array)
    const queriedTx = _.cloneDeep(validatedData.data.transaction)
    if (!queriedTx.blockNumber) {
        log.warning(
            "[handleExecuteTransaction] Queried tx has no block number: " +
            queriedTx.hash,
        )
        const lastBlockNumber = await Chain.getLastBlockNumber()
        queriedTx.blockNumber = lastBlockNumber + 1
        log.warning(
            "[handleExecuteTransaction] Queried tx block number set to: " +
            queriedTx.blockNumber,
        )
    }
    log.debug(
        "[handleExecuteTransaction] Queried tx processing in block: " +
        queriedTx.blockNumber,
    )

    if (validatedData.rpc_public_key.data !== hexOurKey) {
        log.error(
            "SERVER",
            fname + "Invalid validityData signature key (not us) 💀",
        )
        result.success = false
        result.response = false
        result.extra = "Invalid signature key"
        return result
    }

    const hashedData = Hashing.sha256(JSON.stringify(validatedData.data))
    const signatureValid = await ucrypto.verify({
        algorithm: validatedData.signature.type as SigningAlgorithm,
        message: new TextEncoder().encode(hashedData),
        publicKey: hexToUint8Array(
            validatedData.rpc_public_key.data,
        ) as any,
        signature: hexToUint8Array(validatedData.signature.data) as any,
    })

    if (!signatureValid) {
        log.error(
            "[handleExecuteTransaction] Invalid validityData signature: " +
            validatedData.signature.data +
            " - " +
            validatedData.rpc_public_key.data,
        )
        result.success = false
        result.response = false
        result.extra = "Invalid signature"
        return result
    }

    const blockNumber = validatedData.data.reference_block
    const lastBlockNumber = await Chain.getLastBlockNumber()

    if (!isReferenceBlockAllowed(blockNumber, lastBlockNumber)) {
        log.error(
            "[handleExecuteTransaction] Invalid validityData block reference: " +
            blockNumber +
            " - " +
            lastBlockNumber,
        )
        result.success = false
        result.response = false
        result.extra = "Invalid block reference"
        return result
    }

    if (!validatedData.data.valid) {
        log.error(
            "[handleExecuteTransaction] Invalid validityData: " +
            validatedData.data.message,
        )
        result.success = false
        result.response = false
        result.extra = validatedData.data.message
        return result
    }

    log.info("SERVER", fname + "Valid validityData!")
    const tx = _.cloneDeep(validatedData.data.transaction)
    let payload: DemoScript | any

    switch (tx.content.type) {
        case "crosschainOperation":
            payload = tx.content.data
            log.debug(
                "[handleExecuteTransaction] Included XM Chainscript: " +
                JSON.stringify(payload[1]),
            )
            const xmResult = await multichainDispatcher.digest(payload[1] as XMScript)
            result.success = xmResult.success
            result.response = {
                message: xmResult.message,
                results: xmResult.results,
            }
            break

        case "subnet":
            payload = tx.content.data
            log.debug(
                "[handleExecuteTransaction] Subnet payload: " +
                JSON.stringify(payload[1]),
            )
            const subnetResult = await handleL2PS(tx as L2PSTransaction)
            result.response = subnetResult
            break

        case "l2psEncryptedTx": {
            log.debug("[handleExecuteTransaction] Processing L2PS Encrypted Tx")

            if (!tx.signature?.data) {
                log.error("[handleExecuteTransaction] L2PS tx rejected: missing signature")
                result.success = false
                result.response = { error: "L2PS transaction requires valid signature" }
                break
            }

            const l2psPayload = tx.content?.data?.[1]
            if (!l2psPayload || typeof l2psPayload !== "object") {
                log.error("[handleExecuteTransaction] L2PS tx rejected: invalid payload structure")
                result.success = false
                result.response = { error: "Invalid L2PS payload structure" }
                break
            }

            const senderAddress = tx.content?.from || tx.content?.from_ed25519_address
            if (!senderAddress) {
                log.error("[handleExecuteTransaction] L2PS tx rejected: missing sender address")
                result.success = false
                result.response = { error: "L2PS transaction requires sender address" }
                break
            }

            const l2psResult = await handleL2PS(tx as L2PSTransaction)
            result.response = l2psResult
            if (l2psResult.result === 200) {
                result.success = true
                return result
            } else {
                result.success = false
            }
            break
        }

        case "web2Request": {
            payload = tx.content.data[1] as IWeb2Payload
            const params = parseWeb2ProxyRequest(payload)
            const web2Result = await handleWeb2ProxyRequest(params)
            result.response = web2Result
            break
        }

        case "demoswork":
            const demosWorkPayload = tx.content.data
            const demosWorkScript = demosWorkPayload[1] as DemoScript
            try {
                const demosWorkResult =
                    await handleDemosWorkRequest(demosWorkScript)
                result.response = demosWorkResult
            } catch (e) {
                log.error(
                    "[handleExecuteTransaction] Error in demosWork: " + e,
                )
                result.success = false
                result.response = e
                result.extra = "Error in demosWork"
            }
            break

        case "native":
            result.response = {
                message: "Transaction applied, waiting for confirmation",
            }
            result.success = true
            break

        case "identity":
            try {
                const identityResult = await handleIdentityRequest(
                    tx,
                    sender,
                )
                const status = identityResult.success
                    ? "applied"
                    : "not applied"

                result.success = identityResult.success
                result.extra = {
                    message:
                        identityResult.message + `. Transaction ${status}.`,
                }
            } catch (e) {
                log.error("[handleverifyPayload] Error in identity: " + e)
                result.success = false
                result.response = {
                    message: "Failed to verify signature",
                }
                result.extra = {
                    error: e.toString(),
                }
            }
            break

        case "nativeBridge":
            payload = tx.content.data
            const nativeBridgeResult = await handleNativeBridgeTx(
                payload[1] as NativeBridgeOperationCompiled,
            )
            if (nativeBridgeResult === null) {
                result.success = false
                result.response = false
                result.extra = {
                    error: "Failed to handle native bridge transaction",
                }
            }
            result.response = nativeBridgeResult
            break

        case "l2ps_hash_update": {
            const { handleL2PSHashUpdate } = await import("./endpointL2PSHash")
            const l2psHashResult = await handleL2PSHashUpdate(tx)
            result.response = l2psHashResult
            result.success = l2psHashResult.result === 200
            break
        }
    }

    // Only if the transaction is valid we add it to the mempool
    if (result.success) {
        const simulate = true
        const editsResults = await HandleGCR.applyToTx(
            queriedTx,
            false,
            simulate,
        )

        if (!editsResults.success) {
            log.error("[handleExecuteTransaction] Failed to apply GCREdit")
            result.success = false
            result.response = false
            result.extra = {
                error: "Failed to apply GCREdit: " + editsResults.message,
            }
            return result
        }

        log.debug("PROD: " + getSharedState.PROD)
        const { isValidator, validators } = await isValidatorForNextBlock()

        if (!isValidator) {
            log.debug(
                "[DTR] Non-validator node: attempting relay to all validators",
            )
            const availableValidators = validators.sort(
                () => Math.random() - 0.5,
            )

            log.debug(
                `[DTR] Found ${availableValidators.length} available validators, trying all`,
            )

            const results = await Promise.allSettled(
                availableValidators.map(validator =>
                    DTRManager.relayTransactions(validator, [
                        validatedData,
                    ]),
                ),
            )

            for (const result of results) {
                if (result.status === "fulfilled") {
                    const response = result.value
                    if (response.result === 200) {
                        continue
                    }
                    DTRManager.validityDataCache.set(
                        validatedData.data.transaction.hash,
                        validatedData,
                    )
                }
            }

            return {
                success: true,
                response: {
                    message: "Transaction relayed to validators",
                },
                extra: {
                    confirmationBlock: getSharedState.lastBlockNumber + 1,
                },
                require_reply: false,
            }
        }

        if (getSharedState.inConsensusLoop) {
            return await DTRManager.inConsensusHandler(validatedData)
        }

        log.debug(
            "👀 not in consensus loop, adding tx to mempool: " +
            queriedTx.hash,
        )

        log.debug(
            "[handleExecuteTransaction] Adding tx with hash: " +
            queriedTx.hash +
            " to the mempool",
        )
        try {
            const { confirmationBlock, error } =
                await Mempool.addTransaction({
                    ...queriedTx,
                    reference_block: validatedData.data.reference_block,
                })

            log.debug(
                "[handleExecuteTransaction] Transaction added to mempool",
            )

            if (error) {
                result.success = false
                result.response = {
                    message: "Failed to add transaction to mempool",
                }
            }

            result.extra = {
                ...(result.extra ? result.extra : {}),
                confirmationBlock,
                ...(error ? { error } : {}),
            }
        } catch (e) {
            result.success = false
            result.response = false
            result.extra = {
                message: "Failed to add transaction to mempool",
            }

            log.error(
                "[handleExecuteTransaction] Failed to add transaction to mempool: " +
                e,
            )
        }
    }

    return result
}
