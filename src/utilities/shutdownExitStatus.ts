/** Keeps a fatal shutdown request from being lost to an earlier clean one. */
export function createShutdownExitStatus() {
    let code = 0
    return {
        request(exitCode: number) {
            if (exitCode !== 0 && code === 0) code = exitCode
        },
        get code() { return code },
    }
}
