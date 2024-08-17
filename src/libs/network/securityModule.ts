// TODO Implement this
import { ISecurityReport } from "@kynesyslabs/demosdk/types"

export const modules = {
    // SECTION Modules
    // TODO Make some properties configurable
    communications: {
        response_registry: {
            flag_interval: 5000, // Milliseconds between responseRegistry pruning operations // Make it configurable
            flag_hardlimit: 10000, // Maximum number of milliseconds a response can exist
        },
        
    },
}

// SECTION Internal methods
async function checkRateLimits(
    reported_timestamp: number,
): Promise<ISecurityReport> {
    let report: ISecurityReport = {
        code: "0",
        message: "undefined",
        state: undefined,
    }
    // TODO Implement this
    return report
}

// Exporting
