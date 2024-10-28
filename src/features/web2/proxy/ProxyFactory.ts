import { Proxy } from "./Proxy"

/**
 * ProxyFactory - Factory class for creating and managing Proxy instances.
 */
export class ProxyFactory {
    private static _proxyInstances: Map<string, Proxy> = new Map()

    /**
     * Create a new Proxy instance.
     * @param {string} dahrSessionId - The session ID.
     * @returns {Proxy} The created Proxy instance.
     */
    static createProxy(dahrSessionId: string): Proxy {
        if (this._proxyInstances.has(dahrSessionId)) {
            return this._proxyInstances.get(dahrSessionId)!
        }

        const proxy = new Proxy(dahrSessionId)
        this._proxyInstances.set(dahrSessionId, proxy)
        return proxy
    }

    /**
     * Get a Proxy instance by sessionId.
     * @param {string} dahrSessionId - The session ID.
     * @returns {Proxy | undefined} The Proxy instance if found, undefined otherwise.
     */
    static getProxy(dahrSessionId: string): Proxy | undefined {
        return this._proxyInstances.get(dahrSessionId)
    }

    /**
     * Remove a Proxy instance by sessionId.
     * @param {string} dahrSessionId - The session ID.
     */
    static removeProxy(dahrSessionId: string): void {
        const proxy = this._proxyInstances.get(dahrSessionId)
        if (proxy) {
            proxy.stopProxy()
            this._proxyInstances.delete(dahrSessionId)
        }
    }
}
