import { OmniProtocolError, UnknownOpcodeError } from "../types/errors"
import {
    HandlerContext,
    ParsedOmniMessage,
    ReceiveContext,
} from "../types/message"
import { getHandler } from "./registry"
import { OmniOpcode } from "./opcodes"
import { SignatureVerifier } from "../auth/verifier"
import { ERROR_CODE_SIGNING, ERROR_CODE_UNAUTHORIZED } from "../constants"

export interface DispatchOptions<TPayload = unknown> {
    message: ParsedOmniMessage<TPayload>
    context: ReceiveContext
    fallbackToHttp: () => Promise<Buffer>
}

export async function dispatchOmniMessage<TPayload = unknown>(
    options: DispatchOptions<TPayload>,
): Promise<Buffer> {
    const opcode = options.message.header.opcode as OmniOpcode
    const descriptor = getHandler(opcode)

    if (!descriptor) {
        throw new UnknownOpcodeError(opcode)
    }

    // Check if handler requires authentication
    if (descriptor.authRequired) {
        // Verify auth block is present
        if (!options.message.auth) {
            throw new OmniProtocolError(
                `Authentication required for opcode ${descriptor.name} (0x${opcode.toString(16)})`,
                ERROR_CODE_UNAUTHORIZED,
            )
        }

        // Verify signature
        const verificationResult = await SignatureVerifier.verify(
            options.message.auth,
            options.message.header,
            options.message.payload as Buffer,
        )

        if (!verificationResult.valid) {
            throw new OmniProtocolError(
                `Authentication failed for opcode ${descriptor.name}: ${verificationResult.error}`,
                ERROR_CODE_UNAUTHORIZED,
            )
        }

        // Update context with verified identity
        options.context.peerIdentity = verificationResult.peerIdentity!
        options.context.isAuthenticated = true
    }

    const handlerContext: HandlerContext<TPayload> = {
        message: options.message,
        context: options.context,
        fallbackToHttp: options.fallbackToHttp,
    }

    try {
        return await descriptor.handler(handlerContext as HandlerContext<Buffer>)
    } catch (error) {
        if (error instanceof OmniProtocolError) {
            throw error
        }

        throw new OmniProtocolError(
            `Handler for opcode ${descriptor.name} failed: ${String(error)}`,
            ERROR_CODE_SIGNING,
        )
    }
}
