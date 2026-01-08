import required from "./required"
import log from "@/utilities/logger"

// INFO Each non-read task has to be checked here
export default function checkSignedPayloads(
    num: number,
    signedPayloads: any[],
): boolean {
    // NOTE Sanity check on the signedPayloads length
    const sanityCheck = required(
        signedPayloads.length == num,
        "Invalid signedPayloads length",
    )

    if (!sanityCheck) {
        return false
    }

    log.debug("[XMScript Parser] Signed payload seems ok.")
    return true
}
