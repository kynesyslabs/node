/**
 * A state read failed while a block was being applied. It says nothing about
 * the transaction, so the block must not apply at all: recording the
 * transaction as failed would disagree with every node whose read worked.
 */
export class StateReadError extends Error {
    constructor(what: string, cause: unknown) {
        super(`State read failed (${what}): ${cause}`)
        this.name = "StateReadError"
    }
}

export async function readState<T>(what: string, read: () => Promise<T>): Promise<T> {
    try {
        return await read()
    } catch (error) {
        if (error instanceof StateReadError) throw error
        throw new StateReadError(what, error)
    }
}
