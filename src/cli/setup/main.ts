/* eslint-disable no-console -- terminal tool: console is its output */
import { runCli } from "./cli"
import { isForegroundOnTerminal } from "./context"

runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) && isForegroundOnTerminal(),
    say: line => console.log(line),
}).then(
    code => process.exit(code),
    err => {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
    },
)
