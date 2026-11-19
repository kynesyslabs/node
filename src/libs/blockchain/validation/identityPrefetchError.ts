import { StateReadError } from "@/libs/blockchain/gcr/stateReadError"

/**
 * The PQC identity records could not be read. A PQC-only transaction cannot
 * be judged without them, so a forger that met this sits the round out:
 * leaving the transactions out would forge a block the rest of the committee
 * does not.
 */
export class IdentityPrefetchError extends StateReadError {
    constructor(cause: unknown) {
        super("PQC identity records", cause)
        this.name = "IdentityPrefetchError"
    }
}
