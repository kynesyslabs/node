// The one place the node's environment-variable parsing rules live. The node
// reads its settings with these functions and `bun run setup --check` judges
// an existing .env with the same ones, so the checker can never be more or
// less generous than the node. Pure functions: no imports, no side effects.

/**
 * A boolean setting: exactly "true" or "1" is on, anything else non-empty is
 * off, and an unset or empty value is `undefined` so the caller applies its
 * own default.
 */
export function parseBoolFlag(raw: string | undefined): boolean | undefined {
    if (raw === undefined || raw === "") return undefined
    return raw === "true" || raw === "1"
}

/** An integer setting read with parseInt; undefined when unset, empty or not a number. */
export function parseIntSetting(raw: string | undefined): number | undefined {
    if (raw === undefined || raw === "") return undefined
    const parsed = Number.parseInt(raw, 10)
    return Number.isNaN(parsed) ? undefined : parsed
}

/** L2PS_MESSAGING_ENABLED is on only for the word true, in any case. */
export function parseMessagingEnabled(raw: string | undefined): boolean {
    return raw?.toLowerCase() === "true"
}

export const MESSAGING_PORT_DEFAULT = 3006

export interface MessagingPort {
    port: number
    /** "invalid" means the value was set but unusable, so the default was taken. */
    source: "default" | "env" | "invalid"
}

/** L2PS_MESSAGING_PORT: parseInt, then a 1..65535 check, else the default. */
export function parseMessagingPort(raw: string | undefined): MessagingPort {
    if (raw === undefined || raw === "") {
        return { port: MESSAGING_PORT_DEFAULT, source: "default" }
    }
    const n = Number.parseInt(raw, 10)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { port: MESSAGING_PORT_DEFAULT, source: "invalid" }
    }
    return { port: n, source: "env" }
}
