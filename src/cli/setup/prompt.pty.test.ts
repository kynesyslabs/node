import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawnSync } from "node:child_process"
import * as path from "node:path"

setDefaultTimeout(120_000)

// Answers the secret prompt the instant it appears, as a paste or a password
// manager would, and returns everything the terminal showed.
const DRIVER = `
import os, pty, select, sys, time
secret = sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1], sys.argv[3]])
out = b""
sent = False
start = time.time()
while time.time() - start < 15:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            out += os.read(fd, 4096)
        except OSError:
            break
    if not sent and b"Secret: " in out:
        os.write(fd, (secret + "\\n").encode())
        sent = True
    done, _ = os.waitpid(pid, os.WNOHANG)
    if done:
        break
sys.stdout.write(out.decode(errors="replace"))
`

const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0
const harness = path.join(import.meta.dir, "secretHarness.ts")

describe.skipIf(!hasPython)("a secret typed at the terminal", () => {
    it("is never shown, even when it arrives the moment the prompt does", () => {
        const secret = "S3CR3T-KEY-MATERIAL"
        for (let run = 0; run < 8; run++) {
            const r = spawnSync("python3", ["-c", DRIVER, process.execPath, secret, harness], { encoding: "utf8", timeout: 40_000 })
            expect(r.stdout).toContain(`GOT:${secret.length}`)
            expect([run, r.stdout.includes(secret)]).toEqual([run, false])
        }
    })
})
