/**
 * The one load failure that means "this node has nothing for that subnet",
 * as opposed to a subnet it is configured for whose key or config is broken.
 *
 * Carried as a code, not only as a class, so a caller that reaches the loader
 * through a stub or a copy of the module can still tell the two apart.
 */
export const L2PS_NOT_CONFIGURED = "L2PS_NOT_CONFIGURED"

export class L2PSNotConfiguredError extends Error {
    readonly code = L2PS_NOT_CONFIGURED

    constructor(message: string) {
        super(message)
        this.name = "L2PSNotConfiguredError"
    }
}

export function isNotConfigured(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === L2PS_NOT_CONFIGURED
    )
}
