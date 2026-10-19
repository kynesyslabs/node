// C0, DEL, C1 and the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g")

/**
 * Renders a client-provided value for a log line. Control characters would let
 * the sender start a line of their own in the log, and an unbounded value
 * would let one request fill it.
 */
export function sanitizeForLog(value: unknown, maxLength = 64): string {
    const text = typeof value === "string" ? value : String(value)
    const clean = text.replace(CONTROL_CHARACTERS, "")
    return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean
}
