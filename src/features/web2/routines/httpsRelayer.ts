/* INFO Data agnostic HTTPS relay
 * NOTE Workflow:
    * A client uses the SDK to request a secure HTTPS relay
    * The client must specify the target URL and if the relay is secure (aka if the target is using HTTPS)
    * httpsRelayer uses prepareHTTPSRelay to spawn a proxy for the client
    * The proxy is returned to the client that uses it to send data to the target through the SDK
 * TODO & REVIEW
    * The SDK must be able to handle the same format as axios for the request
    * The request must be given to the client using the same format as axios
    * The client must be able to use the proxy to send data to the target using the same format as axios
    * The client must be able to receive the response from the target using the same format as axios
*/

import proxyManager from "./types/proxyManager"

export default class httpsRelayer {
    // Preparing a relay to be used by the client
    // TODO Add authentication/authorization
    static prepareHTTPSRelay(target: string, is_secure: boolean) {
        // Random port number between 8500 and 9400
        let rnd_port = Math.floor(Math.random() * (9400 - 8500) + 8500)
        // We spawn a proxy for this client (NOTE: Is not yet running)
        let spawned_proxy = new proxyManager(rnd_port, target, is_secure)
        let proxy_id: string = spawned_proxy.proxid
        // Run the proxy
        spawned_proxy.run()
        // Return the port and the id
        return [rnd_port, proxy_id]
    }
}
