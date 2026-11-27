import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"
import { Web2SessionLimitError } from "src/features/web2/dahr/sessionLimit"
import { DAHR } from "./dahr/DAHR"
import { sanitizeWeb2RequestForLogging } from "src/features/web2/sanitizeWeb2Request"
import type { Web2FetchCaller } from "src/features/web2/web2FetchLimiter"
import log from "src/utilities/logger"

/**
 * Handles a Web2 request.
 *
 * This function receives a request from a socket and creates a DAHR instance
 * to handle the Web2 proxy functionality.
 *
 * @param {IWeb2Request} web2Request - The Web2 request to handle.
 * @param {Web2FetchCaller} caller - Who the new session counts against.
 *
 * @returns {Promise<DAHR | string>} - Returns a DAHR instance or an error message.
 *
 * @throws {Web2SessionLimitError} When the node holds its maximum of sessions.
 */
export async function handleWeb2(
    web2Request: IWeb2Request,
    caller?: Web2FetchCaller,
): Promise<string | DAHR> {
    // TODO Remember that web2 could need to be signed and could need a fee
    log.debug("[PAYLOAD FOR WEB2] [*] Received a Web2 Payload.")
    log.debug("[PAYLOAD FOR WEB2] [*] Beginning sanitization checks...")

    const sanitizedForLog = sanitizeWeb2RequestForLogging(web2Request)
    log.debug(
        "[PAYLOAD FOR WEB2] [*] Web2 Request: " +
            JSON.stringify(sanitizedForLog),
    )

    log.debug(
        "[REQUEST FOR WEB2] [+] Found and loaded payload.message as expected...",
    )

    try {
        const dahrFactoryInstance = DAHRFactory.instance
        const dahr = await dahrFactoryInstance.createDAHR(web2Request, caller)

        log.debug("[handleWeb2] DAHR instance created.")

        return dahr
    } catch (error) {
        // A full node is answered with 429 by the RPC handler, not as a fault.
        if (error instanceof Web2SessionLimitError) throw error
        log.error("Error in handleWeb2:", error)
        const errorMsg = error instanceof Error ? error.message : String(error)
        return errorMsg
    }
}
