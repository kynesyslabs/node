import { Proxy } from "./Proxy"

/**
 * ProxyFactory - Factory class for creating and managing Proxy instances.
 */
export class ProxyFactory {
    /**
     * Create a new Proxy instance.
     * @param {string} dahrSessionId - The session ID.
     * @returns {Proxy} The created Proxy instance.
     */
    static createProxy(dahrSessionId: string): Proxy {
        return new Proxy(dahrSessionId)
    }
}
