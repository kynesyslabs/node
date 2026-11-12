/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { BURN_ADDRESS } from "./burnAddress"

/**
 * Why a scheduled gasFeeSeparation treasury address is refused, or null when
 * it is accepted: the migration refuses it, and launch tooling reports it
 * before block 0. Kept in a leaf module so the tooling can read it without
 * loading the migration.
 */
export function treasuryAddressProblem(treasuryAddress: unknown): string | null {
    if (
        typeof treasuryAddress !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(treasuryAddress)
    ) {
        return `[forks][gasFeeSeparation] treasuryAddress must match /^0x[0-9a-f]{64}$/, got: ${JSON.stringify(
            treasuryAddress,
        )}`
    }
    if (treasuryAddress === BURN_ADDRESS) {
        return "[forks][gasFeeSeparation] treasuryAddress equals BURN_ADDRESS — refusing to route fees into the burn account (placeholder must be replaced before sealing genesis)."
    }
    return null
}
