import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"
import { DAHR } from "./dahr/DAHR"

/**
 * Handles a Web2 request.
 *
 * This function receives a request from a socket and creates a DAHR instance
 * to handle the Web2 proxy functionality.
 *
 * @param {IWeb2Request} web2Request - The Web2 request to handle.
 *
 * @returns {Promise<DAHR | string>} - Returns a DAHR instance or an error message.
 *
 * @throws Will throw an error if the operation fails.
 */
export async function handleWeb2(
    web2Request: IWeb2Request,
): Promise<string | DAHR> {
    // TODO Remember that web2 could need to be signed and could need a fee
    console.log("[PAYLOAD FOR WEB2] [*] Received a Web2 Payload.")
    console.log("[PAYLOAD FOR WEB2] [*] Beginning sanitization checks...")

    console.log(
        "[REQUEST FOR WEB2] [+] Found and loaded payload.message as expected...",
    )

    try {
        const dahrFactoryInstance = DAHRFactory.instance
        const dahr = await dahrFactoryInstance.createDAHR(web2Request)

        console.log("[handleWeb2] DAHR instance created.")

        return dahr
    } catch (error: any) {
        console.error("Error in handleWeb2:", error)
        return error.message
    }
}
