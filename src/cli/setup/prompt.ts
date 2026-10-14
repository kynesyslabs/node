import { Writable } from "node:stream"
import * as readline from "node:readline/promises"

export class SetupAborted extends Error {
    constructor() {
        super("Setup cancelled")
    }
}

/** The one primitive a terminal has to provide; everything else is built on it. */
export interface Prompter {
    readLine(question: string, opts?: { secret?: boolean }): Promise<string>
}

export function createReadlinePrompter(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
): Prompter {
    return {
        async readLine(question, opts) {
            // A secret is read through a muted stream so it is never echoed.
            const silent = new Writable({ write: (_c, _e, cb) => cb() })
            if (opts?.secret) output.write(question)
            const rl = readline.createInterface({
                input,
                output: opts?.secret ? silent : output,
                terminal: Boolean((input as NodeJS.ReadStream).isTTY),
            })
            const closed = new Promise<never>((_, reject) =>
                rl.once("close", () => reject(new SetupAborted())),
            )
            try {
                const answer = await Promise.race([
                    rl.question(opts?.secret ? "" : question),
                    closed,
                ])
                if (opts?.secret) output.write("\n")
                return answer
            } finally {
                rl.close()
            }
        },
    }
}

export interface AskOptions {
    default?: string
    /** Returns an error message, or null when the answer is fine. */
    validate?: (value: string) => string | null
    secret?: boolean
    say?: (line: string) => void
}

export async function ask(
    p: Prompter,
    question: string,
    opts: AskOptions = {},
): Promise<string> {
    const say = opts.say ?? ((l: string) => console.log(l))
    const hint = opts.default !== undefined && opts.default !== "" ? ` [${opts.default}]` : ""
    for (;;) {
        const raw = (await p.readLine(`${question}${hint}: `, { secret: opts.secret })).trim()
        const value = raw === "" ? (opts.default ?? "") : raw
        const error = opts.validate?.(value) ?? null
        if (error === null) return value
        say(`  ${error}`)
    }
}

export async function confirm(
    p: Prompter,
    question: string,
    def: boolean,
    say: (line: string) => void = l => console.log(l),
): Promise<boolean> {
    for (;;) {
        const raw = (
            await p.readLine(`${question} [${def ? "Y/n" : "y/N"}]: `)
        )
            .trim()
            .toLowerCase()
        if (raw === "") return def
        if (["y", "yes"].includes(raw)) return true
        if (["n", "no"].includes(raw)) return false
        say("  Please answer y or n")
    }
}

export async function select<T extends string>(
    p: Prompter,
    question: string,
    choices: Array<{ value: T; label: string }>,
    def: T,
    say: (line: string) => void = l => console.log(l),
): Promise<T> {
    say(question)
    choices.forEach((c, i) => say(`  ${i + 1}) ${c.label}`))
    const defIndex = choices.findIndex(c => c.value === def) + 1
    for (;;) {
        const raw = (await p.readLine(`Choose [${defIndex}]: `)).trim()
        if (raw === "") return def
        const byNumber = choices[Number(raw) - 1]
        if (byNumber) return byNumber.value
        const byValue = choices.find(c => c.value === raw.toLowerCase())
        if (byValue) return byValue.value
        say(`  Enter a number from 1 to ${choices.length}`)
    }
}
