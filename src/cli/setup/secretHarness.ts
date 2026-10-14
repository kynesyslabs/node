/* eslint-disable no-console -- test harness: console is its output */
// Run by prompt.pty.test.ts inside a real pseudo-terminal.
import { createReadlinePrompter } from "./prompt"

const answer = await createReadlinePrompter().readLine("Secret: ", { secret: true })
console.log(`GOT:${answer.length}`)
