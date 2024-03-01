import required from "./required"

// INFO Each non-read task has to be checked here
export default function checkSignedPayloads(
    num: number,
    signedPayloads: any[],
): boolean {
    // NOTE Sanity check on the signedPayloads length
    let sanityCheck = required(
        signedPayloads.length == num,
        "Invalid signedPayloads length",
    )

    if (!sanityCheck) {
        return false
    }

    console.log("[XMScript Parser] Signed payload seems ok.")
    return true
}
