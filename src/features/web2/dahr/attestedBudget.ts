import { WEB2_ATTESTED_RETAIN_MAX_BYTES } from "src/utilities/constants"

// Bytes of attested responses kept across all sessions. A response that
// does not fit is not kept, and its broadcast fetches the origin again.
let retained = 0

export function reserveAttestedBytes(bytes: number): boolean {
    if (retained + bytes > WEB2_ATTESTED_RETAIN_MAX_BYTES) return false
    retained += bytes
    return true
}

export function releaseAttestedBytes(bytes: number): void {
    retained = Math.max(0, retained - bytes)
}

export function retainedAttestedBytes(): number {
    return retained
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetAttestedBudget(): void {
    retained = 0
}
