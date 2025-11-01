import { OmniProtocolError, UnknownOpcodeError } from "../types/errors"
import {
    HandlerContext,
    ParsedOmniMessage,
    ReceiveContext,
} from "../types/message"
import { getHandler } from "./registry"
import { OmniOpcode } from "./opcodes"

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

    const handlerContext: HandlerContext<TPayload> = {
        message: options.message,
        context: options.context,
        fallbackToHttp: options.fallbackToHttp,
    }

    try {
        return await descriptor.handler(handlerContext)
    } catch (error) {
        if (error instanceof OmniProtocolError) {
            throw error
        }

        throw new OmniProtocolError(
            `Handler for opcode ${descriptor.name} failed: ${String(error)}`,
            0xf001,
        )
    }
}
