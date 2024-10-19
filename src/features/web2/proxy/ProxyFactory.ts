import { Proxy } from "./Proxy"

/**
 * ProxyFactory - Factory class for creating and managing Proxy instances.
 */
export class ProxyFactory {
    private static _proxyInstances: Map<string, Proxy> = new Map()

    /**
     * Create a new Proxy instance.
     * @param {string} sessionId - The session ID.
     * @param {string} targetUrl - The target URL.
     * @returns {Proxy} The created Proxy instance.
     */
    static createProxy(sessionId: string, targetUrl: string): Proxy {
        if (this._proxyInstances.has(sessionId)) {
            return this._proxyInstances.get(sessionId)!
        }

        const newProxy = new Proxy(sessionId, targetUrl)
        this._proxyInstances.set(sessionId, newProxy)
        return newProxy
    }

    /**
     * Get a Proxy instance by sessionId.
     * @param {string} sessionId - The session ID.
     * @returns {Proxy | undefined} The Proxy instance if found, undefined otherwise.
     */
    static getProxy(sessionId: string): Proxy | undefined {
        return this._proxyInstances.get(sessionId)
    }

    /**
     * Remove a Proxy instance by sessionId.
     * @param {string} sessionId - The session ID.
     */
    static removeProxy(sessionId: string): void {
        const proxy = this._proxyInstances.get(sessionId)
        if (proxy) {
            proxy.stopProxy()
            this._proxyInstances.delete(sessionId)
        }
    }
}
