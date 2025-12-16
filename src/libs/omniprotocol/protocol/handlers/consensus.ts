// REVIEW: Consensus handlers for OmniProtocol binary communication
import log from "src/utilities/logger"
import { OmniHandler } from "../../types/message"
import {
    decodeProposeBlockHashRequest,
    encodeProposeBlockHashResponse,
    decodeSetValidatorPhaseRequest,
    encodeSetValidatorPhaseResponse,
    decodeGreenlightRequest,
    encodeGreenlightResponse,
    encodeValidatorSeedResponse,
    encodeValidatorTimestampResponse,
    encodeBlockTimestampResponse,
    encodeValidatorPhaseResponse,
} from "../../serialization/consensus"

/**
 * Handler for 0x31 proposeBlockHash opcode
 *
 * Handles block hash proposal from secretary to shard members for voting.
 * Wraps the existing HTTP consensus_routine handler with binary encoding.
 */
export const handleProposeBlockHash: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeProposeBlockHashResponse({
            status: 400,
            voter: "",
            voteAccepted: false,
            signatures: {},
        })
    }

    try {
        const request = decodeProposeBlockHashRequest(message.payload)
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        // Convert binary request to HTTP-style payload
        const httpPayload = {
            method: "proposeBlockHash" as const,
            params: [
                request.blockHash,
                { signatures: request.validationData },
                request.proposer,
            ],
        }

        // Call existing HTTP handler
        const httpResponse = await manageConsensusRoutines(context.peerIdentity, httpPayload)

        // Convert HTTP response to binary format
        return encodeProposeBlockHashResponse({
            status: httpResponse.result,
            voter: (httpResponse.response as string) ?? "",
            voteAccepted: httpResponse.result === 200,
            signatures: (httpResponse.extra?.signatures as Record<string, string>) ?? {},
            metadata: httpResponse.extra,
        })
    } catch (error) {
        log.error("[handleProposeBlockHash] Error: " + error)
        return encodeProposeBlockHashResponse({
            status: 500,
            voter: "",
            voteAccepted: false,
            signatures: {},
            metadata: { error: String(error) },
        })
    }
}

/**
 * Handler for 0x35 setValidatorPhase opcode
 *
 * Handles validator phase updates from validators to secretary.
 * Secretary uses this to coordinate consensus phase transitions.
 */
export const handleSetValidatorPhase: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeSetValidatorPhaseResponse({
            status: 400,
            greenlight: false,
            timestamp: BigInt(0),
            blockRef: BigInt(0),
        })
    }

    try {
        const request = decodeSetValidatorPhaseRequest(message.payload)
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        // Convert binary request to HTTP-style payload
        const httpPayload = {
            method: "setValidatorPhase" as const,
            params: [request.phase, request.seed, Number(request.blockRef)],
        }

        // Call existing HTTP handler
        const httpResponse = await manageConsensusRoutines(context.peerIdentity, httpPayload)

        // Convert HTTP response to binary format
        return encodeSetValidatorPhaseResponse({
            status: httpResponse.result,
            greenlight: httpResponse.extra?.greenlight ?? false,
            timestamp: BigInt(httpResponse.extra?.timestamp ?? 0),
            blockRef: BigInt(httpResponse.extra?.blockRef ?? 0),
            metadata: httpResponse.extra,
        })
    } catch (error) {
        log.error("[handleSetValidatorPhase] Error: " + error)
        return encodeSetValidatorPhaseResponse({
            status: 500,
            greenlight: false,
            timestamp: BigInt(0),
            blockRef: BigInt(0),
            metadata: { error: String(error) },
        })
    }
}

/**
 * Handler for 0x37 greenlight opcode
 *
 * Handles greenlight messages from secretary to validators.
 * Signals validators that they can proceed to the next consensus phase.
 */
export const handleGreenlight: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeGreenlightResponse({
            status: 400,
            accepted: false,
        })
    }

    try {
        const request = decodeGreenlightRequest(message.payload)
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        // Convert binary request to HTTP-style payload
        const httpPayload = {
            method: "greenlight" as const,
            params: [Number(request.blockRef), Number(request.timestamp), request.phase],
        }

        // Call existing HTTP handler
        const httpResponse = await manageConsensusRoutines(context.peerIdentity, httpPayload)

        // Convert HTTP response to binary format
        return encodeGreenlightResponse({
            status: httpResponse.result,
            accepted: httpResponse.result === 200,
        })
    } catch (error) {
        log.error("[handleGreenlight] Error: " + error)
        return encodeGreenlightResponse({
            status: 500,
            accepted: false,
        })
    }
}

/**
 * Handler for 0x33 getCommonValidatorSeed opcode
 *
 * Returns the common validator seed used for shard selection.
 */
export const handleGetCommonValidatorSeed: OmniHandler<Buffer> = async () => {
    try {
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        const httpPayload = {
            method: "getCommonValidatorSeed" as const,
            params: [],
        }

        const httpResponse = await manageConsensusRoutines("", httpPayload)

        return encodeValidatorSeedResponse({
            status: httpResponse.result,
            seed: (httpResponse.response as string) ?? "",
        })
    } catch (error) {
        log.error("[handleGetCommonValidatorSeed] Error: " + error)
        return encodeValidatorSeedResponse({
            status: 500,
            seed: "",
        })
    }
}

/**
 * Handler for 0x34 getValidatorTimestamp opcode
 *
 * Returns the current validator timestamp for block time averaging.
 */
export const handleGetValidatorTimestamp: OmniHandler<Buffer> = async () => {
    try {
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        const httpPayload = {
            method: "getValidatorTimestamp" as const,
            params: [],
        }

        const httpResponse = await manageConsensusRoutines("", httpPayload)

        return encodeValidatorTimestampResponse({
            status: httpResponse.result,
            timestamp: BigInt(httpResponse.response ?? 0),
            metadata: httpResponse.extra,
        })
    } catch (error) {
        log.error("[handleGetValidatorTimestamp] Error: " + error)
        return encodeValidatorTimestampResponse({
            status: 500,
            timestamp: BigInt(0),
        })
    }
}

/**
 * Handler for 0x38 getBlockTimestamp opcode
 *
 * Returns the block timestamp from the secretary.
 */
export const handleGetBlockTimestamp: OmniHandler<Buffer> = async () => {
    try {
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        const httpPayload = {
            method: "getBlockTimestamp" as const,
            params: [],
        }

        const httpResponse = await manageConsensusRoutines("", httpPayload)

        return encodeBlockTimestampResponse({
            status: httpResponse.result,
            timestamp: BigInt(httpResponse.response ?? 0),
            metadata: httpResponse.extra,
        })
    } catch (error) {
        log.error("[handleGetBlockTimestamp] Error: " + error)
        return encodeBlockTimestampResponse({
            status: 500,
            timestamp: BigInt(0),
        })
    }
}

/**
 * Handler for 0x36 getValidatorPhase opcode
 *
 * Returns the current validator phase status.
 */
export const handleGetValidatorPhase: OmniHandler<Buffer> = async () => {
    try {
        const { default: manageConsensusRoutines } = await import(
            "../../../network/manageConsensusRoutines"
        )

        const httpPayload = {
            method: "getValidatorPhase" as const,
            params: [],
        }

        const httpResponse = await manageConsensusRoutines("", httpPayload)

        // Parse response to extract phase information
        const hasPhase = httpResponse.result === 200
        const phase = typeof httpResponse.response === "number" ? httpResponse.response : 0

        return encodeValidatorPhaseResponse({
            status: httpResponse.result,
            hasPhase,
            phase,
            metadata: httpResponse.extra,
        })
    } catch (error) {
        log.error("[handleGetValidatorPhase] Error: " + error)
        return encodeValidatorPhaseResponse({
            status: 500,
            hasPhase: false,
            phase: 0,
        })
    }
}
