// Run by startupGate.pty.test.ts inside a real pseudo-terminal: the gate's
// terminal detection, Ctrl-C and end-of-input handling only exist there.
import { enforceGuidedSetup } from "./startupGate"

await enforceGuidedSetup({
    cwd: process.env.HARNESS_ROOT,
    env: { ...process.env },
    offerTimeoutMs: Number(process.env.HARNESS_TIMEOUT_MS ?? 30_000),
})
console.log("BOOTED")
