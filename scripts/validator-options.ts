export interface ValidatorFlags {
    [key: string]: string
}

export function resolveStakeConnectionUrl(
    flags: ValidatorFlags,
    env: Record<string, string | undefined>,
): string {
    const value = flags["connection-url"] ?? env.EXPOSED_URL
    if (!value) {
        throw new Error(
            "stake requires --connection-url <public-url> or EXPOSED_URL",
        )
    }
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new Error("stake connection URL must be a valid HTTP(S) URL")
    }
    if (
        !new Set(["http:", "https:"]).has(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
    ) {
        throw new Error(
            "stake connection URL must contain only an HTTP(S) scheme, host, and optional port",
        )
    }
    return parsed.toString().replace(/\/$/, "")
}
