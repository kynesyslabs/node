/**
 * OmniProtocol Consensus Adapter
 *
 * Routes consensus RPC calls to dedicated OmniProtocol opcodes for binary-efficient
 * communication during consensus phases. Falls back to NODE_CALL for unsupported methods.
 */

import log from "src/utilities/logger"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import Peer from "src/libs/peer/Peer"

import { BaseAdapterOptions } from "./BaseAdapter"
import { OmniOpcode } from "../protocol/opcodes"
import {
    encodeSetValidatorPhaseRequest,
    decodeSetValidatorPhaseResponse,
    encodeGreenlightRequest,
    decodeGreenlightResponse,
    encodeProposeBlockHashRequest,
    decodeProposeBlockHashResponse,
    SetValidatorPhaseResponsePayload,
    GreenlightResponsePayload,
    ProposeBlockHashResponsePayload,
} from "../serialization/consensus"
import {
    encodeNodeCallRequest,
    decodeNodeCallResponse,
} from "../serialization/control"

export type ConsensusAdapterOptions = BaseAdapterOptions

// REVIEW: Union type for all consensus response payloads
type ConsensusDecodedResponse =
    | SetValidatorPhaseResponsePayload
    | GreenlightResponsePayload
    | ProposeBlockHashResponsePayload

// REVIEW: Mapping of consensus method names to their dedicated opcodes
const CONSENSUS_METHOD_TO_OPCODE: Record<string, OmniOpcode> = {
    setValidatorPhase: OmniOpcode.SET_VALIDATOR_PHASE,
    getValidatorPhase: OmniOpcode.GET_VALIDATOR_PHASE,
    greenlight: OmniOpcode.GREENLIGHT,
    proposeBlockHash: OmniOpcode.PROPOSE_BLOCK_HASH,
    getCommonValidatorSeed: OmniOpcode.GET_COMMON_VALIDATOR_SEED,
    getValidatorTimestamp: OmniOpcode.GET_VALIDATOR_TIMESTAMP,
    getBlockTimestamp: OmniOpcode.GET_BLOCK_TIMESTAMP,
}

// export class ConsensusOmniAdapter extends BaseOmniAdapter {
//     constructor(options: ConsensusAdapterOptions = {}) {
//         super(options)
//     }

//     /**
//      * Adapt a consensus_routine call to use dedicated OmniProtocol opcodes
//      * @param peer Target peer
//      * @param innerMethod Consensus method name (e.g., "setValidatorPhase")
//      * @param innerParams Consensus method parameters
//      * @returns RPCResponse
//      */
//     async adaptConsensusCall(
//         peer: Peer,
//         innerMethod: string,
//         innerParams: unknown[],
//     ): Promise<RPCResponse> {
//         if (!this.shouldUseOmni(peer.identity)) {
//             // Fall back to HTTP via consensus_routine envelope
//             return peer.httpCall(
//                 {
//                     method: "consensus_routine",
//                     params: [{ method: innerMethod, params: innerParams }],
//                 },
//                 true,
//             )
//         }

//         const opcode = CONSENSUS_METHOD_TO_OPCODE[innerMethod]

//         // If no dedicated opcode, use NODE_CALL with consensus_routine envelope
//         if (!opcode) {
//             return this.sendViaNodeCall(peer, innerMethod, innerParams)
//         }

//         try {
//             const tcpConnectionString = this.httpToTcpConnectionString(peer.connection.string)
//             const privateKey = this.getPrivateKey()
//             const publicKey = this.getPublicKey()

//             if (!privateKey || !publicKey) {
//                 log.warning(
//                     "[ConsensusOmniAdapter] Node keys not available, falling back to HTTP",
//                 )
//                 return peer.httpCall(
//                     {
//                         method: "consensus_routine",
//                         params: [{ method: innerMethod, params: innerParams }],
//                     },
//                     true,
//                 )
//             }

//             // Route to appropriate encoder/decoder based on method
//             const { payload, decoder } = this.getEncoderDecoder(innerMethod, innerParams)

//             // Send authenticated request via dedicated opcode
//             const responseBuffer = await this.connectionPool.sendAuthenticated(
//                 peer.identity,
//                 tcpConnectionString,
//                 opcode,
//                 payload,
//                 privateKey,
//                 publicKey,
//                 {
//                     timeout: 30000,
//                 },
//             )

//             // Decode response
//             const decoded = decoder(responseBuffer)

//             return {
//                 result: decoded.status,
//                 response: this.extractResponseValue(innerMethod, decoded),
//                 require_reply: false,
//                 extra: "metadata" in decoded ? decoded.metadata : decoded,
//             }
//         } catch (error) {
//             this.handleFatalError(error, `OmniProtocol consensus failed for ${peer.identity}`)

//             log.warning(
//                 `[ConsensusOmniAdapter] OmniProtocol failed for ${peer.identity}, falling back to HTTP: ` +
//                     error,
//             )

//             this.markHttpPeer(peer.identity)

//             return peer.httpCall(
//                 {
//                     method: "consensus_routine",
//                     params: [{ method: innerMethod, params: innerParams }],
//                 },
//                 true,
//             )
//         }
//     }

//     /**
//      * Send via NODE_CALL opcode with consensus_routine envelope
//      * Used for consensus methods without dedicated opcodes
//      */
//     private async sendViaNodeCall(
//         peer: Peer,
//         innerMethod: string,
//         innerParams: unknown[],
//     ): Promise<RPCResponse> {
//         try {
//             const tcpConnectionString = this.httpToTcpConnectionString(peer.connection.string)
//             const privateKey = this.getPrivateKey()
//             const publicKey = this.getPublicKey()

//             if (!privateKey || !publicKey) {
//                 return peer.httpCall(
//                     {
//                         method: "consensus_routine",
//                         params: [{ method: innerMethod, params: innerParams }],
//                     },
//                     true,
//                 )
//             }

//             // Encode as consensus_routine envelope in NODE_CALL format
//             const payload = encodeNodeCallRequest({
//                 method: "consensus_routine",
//                 params: [{ method: innerMethod, params: innerParams }],
//             })

//             const responseBuffer = await this.connectionPool.sendAuthenticated(
//                 peer.identity,
//                 tcpConnectionString,
//                 OmniOpcode.NODE_CALL,
//                 payload,
//                 privateKey,
//                 publicKey,
//                 {
//                     timeout: 30000,
//                 },
//             )

//             const decoded = decodeNodeCallResponse(responseBuffer)

//             return {
//                 result: decoded.status,
//                 response: decoded.value,
//                 require_reply: decoded.requireReply,
//                 extra: decoded.extra,
//             }
//         } catch (error) {
//             this.handleFatalError(error, `OmniProtocol NODE_CALL failed for ${peer.identity}`)

//             log.warning(
//                 `[ConsensusOmniAdapter] NODE_CALL failed for ${peer.identity}, falling back to HTTP: ` +
//                     error,
//             )

//             this.markHttpPeer(peer.identity)

//             return peer.httpCall(
//                 {
//                     method: "consensus_routine",
//                     params: [{ method: innerMethod, params: innerParams }],
//                 },
//                 true,
//             )
//         }
//     }

//     /**
//      * Get encoder and decoder functions for a consensus method
//      */
//     private getEncoderDecoder(
//         method: string,
//         params: unknown[],
//     ): { payload: Buffer; decoder: (buf: Buffer) => ConsensusDecodedResponse } {
//         switch (method) {
//             case "setValidatorPhase": {
//                 const [phase, seed, blockRef] = params as [number, string, number]
//                 return {
//                     payload: encodeSetValidatorPhaseRequest({
//                         phase,
//                         seed,
//                         blockRef: BigInt(blockRef ?? 0),
//                     }),
//                     decoder: decodeSetValidatorPhaseResponse,
//                 }
//             }
//             case "greenlight": {
//                 const [blockRef, timestamp, phase] = params as [number, number, number]
//                 return {
//                     payload: encodeGreenlightRequest({
//                         blockRef: BigInt(blockRef ?? 0),
//                         timestamp: BigInt(timestamp ?? 0),
//                         phase: phase ?? 0,
//                     }),
//                     decoder: decodeGreenlightResponse,
//                 }
//             }
//             case "proposeBlockHash": {
//                 const [blockHash, validationData, proposer] = params as [
//                     string,
//                     { signatures: Record<string, string> },
//                     string,
//                 ]
//                 return {
//                     payload: encodeProposeBlockHashRequest({
//                         blockHash,
//                         validationData: validationData?.signatures ?? {},
//                         proposer,
//                     }),
//                     decoder: decodeProposeBlockHashResponse,
//                 }
//             }
//             default:
//                 // For methods without binary serializers, use NODE_CALL fallback
//                 throw new Error(`No binary serializer for method: ${method}`)
//         }
//     }

//     /**
//      * Extract the main response value from decoded consensus response
//      */
//     private extractResponseValue(method: string, decoded: ConsensusDecodedResponse): unknown {
//         switch (method) {
//             case "setValidatorPhase":
//                 return (decoded as SetValidatorPhaseResponsePayload).greenlight ?? null
//             case "greenlight":
//                 return (decoded as GreenlightResponsePayload).accepted ?? null
//             case "proposeBlockHash":
//                 return (decoded as ProposeBlockHashResponsePayload).voter ?? null
//             default:
//                 return decoded
//         }
//     }
// }

// export default ConsensusOmniAdapter
