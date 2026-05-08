/**
 * Helpers that materialise transient docker-compose override files in the
 * devnet directory, so we can run `docker compose -f docker-compose.yml
 * -f docker-compose.override.<scenario>.yml ...` without polluting the
 * canonical compose file.
 *
 * Override files are ALWAYS deleted on scenario teardown (the scenario
 * harness handles teardown via `restoreProductionGenesis()` + `downHard()`,
 * but cleanup of override files is the helper's responsibility).
 */

import { writeFileSync, unlinkSync, existsSync } from "fs"
import { resolve } from "path"
import { DEVNET_DIR, compose } from "./devnetControl"

/** Per-scenario override filenames. */
export function overridePath(scenarioId: string): string {
    return resolve(DEVNET_DIR, `docker-compose.override.${scenarioId}.yml`)
}

/** Writes (or overwrites) the override file for a scenario. */
export function writeOverride(scenarioId: string, body: string): string {
    const p = overridePath(scenarioId)
    writeFileSync(p, body)
    return p
}

/** Deletes the override file. Idempotent. */
export function clearOverride(scenarioId: string): void {
    const p = overridePath(scenarioId)
    if (existsSync(p)) {
        try {
            unlinkSync(p)
        } catch {
            /* ignore */
        }
    }
}

/**
 * Like `compose` from devnetControl, but always layers in the override
 * file for this scenario. The override file must exist before calling.
 */
export function composeWithOverride(
    scenarioId: string,
    args: string[],
    opts: { allowFail?: boolean } = {},
): string {
    return compose(
        [
            "-f",
            "docker-compose.yml",
            "-f",
            `docker-compose.override.${scenarioId}.yml`,
            ...args,
        ],
        opts,
    )
}

/**
 * Convenience: builds an override that only sets env vars on the named
 * services. Each service entry is `serviceName -> { ENV_NAME: value }`.
 */
export function envOverrideYaml(
    serviceEnvs: Record<string, Record<string, string>>,
    profilesByService: Record<string, string[]> = {},
): string {
    const lines: string[] = ["services:"]
    for (const [service, env] of Object.entries(serviceEnvs)) {
        lines.push(`  ${service}:`)
        const profiles = profilesByService[service]
        if (profiles && profiles.length > 0) {
            lines.push(`    profiles: [${profiles.join(", ")}]`)
        }
        lines.push("    environment:")
        for (const [k, v] of Object.entries(env)) {
            // Quote to keep values that look like booleans typed as strings.
            lines.push(`      ${k}: "${v}"`)
        }
    }
    return lines.join("\n") + "\n"
}
