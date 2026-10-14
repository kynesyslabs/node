import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { PYTHON, makeRoot, ptyAvailable, removeRoot, writeSubnet } from "./testSupport"

// Drives gateHarness.ts under a pseudo-terminal. The child waits for the
// prompt text before it sends the keys, so the result does not depend on how
// fast the runtime starts.
const DRIVER = `
import os, pty, select, signal, sys, time
cmd, wait_for, send, stdin_mode, stdout_mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
env = dict(os.environ)
if stdout_mode == "pipe":
    r, w = os.pipe()
pid, fd = pty.fork()
if pid == 0:
    if stdin_mode == "null":
        os.dup2(os.open("/dev/null", os.O_RDONLY), 0)
    if stdout_mode == "pipe":
        os.dup2(os.open("/dev/null", os.O_WRONLY), 1)
    if stdin_mode == "background":
        # Like \`node &\` in an interactive shell: a process group that is not
        # the terminal's foreground one, so reading the terminal stops it.
        grand = os.fork()
        if grand == 0:
            os.setpgid(0, 0)
            os.execvpe(cmd, [cmd, sys.argv[6]], env)
        _, st = os.waitpid(grand, 0)
        os._exit(os.waitstatus_to_exitcode(st) & 255)
    os.execvpe(cmd, [cmd, sys.argv[6]], env)
out = b""
start = time.time()
sent = send == "-"
status = None
while time.time() - start < 90:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b""
        out += data
    if not sent and wait_for.encode() in out:
        os.write(fd, send.encode().decode("unicode_escape").encode("latin1"))
        sent = True
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
if status is None:
    os.kill(pid, signal.SIGKILL)
    print("HANG")
else:
    print("EXIT", os.waitstatus_to_exitcode(status))
sys.stdout.write(out.decode(errors="replace"))
`

// Each case starts a real process and waits for its prompt.
setDefaultTimeout(240_000)

const harness = path.join(import.meta.dir, "gateHarness.ts")

let root: string
beforeEach(() => {
    root = makeRoot()
    writeSubnet(root, "broken", { key: null })
})
afterEach(() => removeRoot(root))

function drive(opts: { send?: string; timeoutMs?: number; stdin?: "tty" | "null" | "background"; stdout?: "tty" | "pipe"; env?: Record<string, string> }) {
    const r = spawnSync(
        PYTHON as string,
        ["-c", DRIVER, process.execPath, "Run the setup now?", opts.send ?? "-", opts.stdin ?? "tty", opts.stdout ?? "tty", harness],
        {
            encoding: "utf8",
            timeout: 150_000,
            env: { ...process.env, CI: "", HARNESS_ROOT: root, HARNESS_TIMEOUT_MS: String(opts.timeoutMs ?? 30_000), ...opts.env },
        },
    )
    if (!r.stdout) console.error("driver failed:", r.status, r.signal, r.stderr)
    const [first, ...rest] = r.stdout.split("\n")
    // Strip terminal control sequences so assertions read plain text.
    // eslint-disable-next-line no-control-regex -- the escape character is what is being stripped
    const text = rest.join("\n").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    return { exit: first.replace("EXIT ", ""), text }
}

describe.skipIf(!ptyAvailable)("the start-up offer on a real terminal", () => {
    it("Ctrl-C aborts the start with 130 and says so", () => {
        const r = drive({ send: "\\x03" })
        expect(r.exit).toBe("130")
        expect(r.text).toContain("Aborted by the operator")
        expect(r.text).not.toContain("BOOTED")
    })

    it("Ctrl-D (end of input) aborts the same way", () => {
        const r = drive({ send: "\\x04" })
        expect(r.exit).toBe("130")
        expect(r.text).not.toContain("BOOTED")
    })

    it("Enter and n continue booting", () => {
        for (const send of ["\\n", "n\\n"]) {
            const r = drive({ send })
            expect(r.exit).toBe("0")
            expect(r.text).toContain("Continuing without the setup")
            expect(r.text).toContain("BOOTED")
        }
    })

    it("no answer continues booting after the window, and the process ends on its own", () => {
        const r = drive({ timeoutMs: 1500 })
        expect(r.exit).toBe("0")
        expect(r.text).toContain("No answer in time")
        expect(r.text).toContain("BOOTED")
    })

    it("never asks when stdin is not a terminal (service manager, </dev/null)", () => {
        const r = drive({ stdin: "null" })
        expect(r.exit).toBe("0")
        expect(r.text).toContain("DEMOS NODE SETUP WARNING")
        expect(r.text).not.toContain("Run the setup now?")
        expect(r.text).toContain("BOOTED")
    })

    it("never asks when started in the background of a terminal, where reading would stop it", () => {
        const r = drive({ stdin: "background", timeoutMs: 30_000 })
        expect(r.exit).toBe("0")
        expect(r.text).toContain("DEMOS NODE SETUP WARNING")
        expect(r.text).not.toContain("Run the setup now?")
        expect(r.text).toContain("BOOTED")
    })

    it("never asks when stdout is not a terminal (output piped to a log)", () => {
        const r = drive({ stdout: "pipe" })
        expect(r.exit).toBe("0")
    })

    it("never asks under CI, even with a terminal", () => {
        const r = drive({ env: { CI: "true" } })
        expect(r.exit).toBe("0")
        expect(r.text).not.toContain("Run the setup now?")
        expect(r.text).toContain("BOOTED")
    })
})
