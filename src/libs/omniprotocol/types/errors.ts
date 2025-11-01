export class OmniProtocolError extends Error {
    constructor(message: string, public readonly code: number) {
        super(message)
        this.name = "OmniProtocolError"
    }
}

export class UnknownOpcodeError extends OmniProtocolError {
    constructor(public readonly opcode: number) {
        super(`Unknown OmniProtocol opcode: 0x${opcode.toString(16)}`, 0xf000)
        this.name = "UnknownOpcodeError"
    }
}

