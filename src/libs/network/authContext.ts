/**
 * Auth Context Module
 *
 * Provides request-scoped authentication context for passing
 * verified identity information from middleware to route handlers.
 * Uses WeakMap to avoid memory leaks and maintain request isolation.
 */

export interface AuthContext {
    /**
     * Whether the signature has been verified
     */
    verified: boolean

    /**
     * The verified identity string (e.g., "ed25519:abc123...")
     */
    identity: string | null

    /**
     * The public key portion extracted from identity
     */
    publicKey: string | null

    /**
     * The signature algorithm used (ed25519, falcon, ml-dsa)
     */
    algorithm: string | null
}

/**
 * WeakMap storage for auth context per request
 * Using WeakMap ensures automatic cleanup when Request is garbage collected
 */
const authContextMap = new WeakMap<Request, AuthContext>()

/**
 * Set the auth context for a request
 * Called by rate limiter middleware after signature verification
 */
export function setAuthContext(req: Request, ctx: AuthContext): void {
    authContextMap.set(req, ctx)
}

/**
 * Get the auth context for a request
 * Returns default context if no context was set (unverified request)
 */
export function getAuthContext(req: Request): AuthContext {
    return (
        authContextMap.get(req) ||
        ({
            verified: false,
            identity: null,
            publicKey: null,
            algorithm: null,
        } as AuthContext)
    )
}
