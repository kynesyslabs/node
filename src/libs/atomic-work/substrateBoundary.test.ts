import { describe, expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import {
    atomicWorkProfile,
    registeredAtomicWorkProfiles,
} from "@/libs/atomic-work/profile"
import { validateOperationGraph, OperationGraphError } from "@/libs/atomic-work/operationGraph"
import { registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"

/**
 * The line the epic draws: the substrate executes Works, the binding knows
 * what a Work is for. It is easy to erase by accident — one convenient import
 * of a rail id or a role name and the generic engine quietly becomes a DACS
 * engine, which is precisely what "generic atomic support does not advertise
 * DACS support" forbids.
 */

const SUBSTRATE = join(import.meta.dir)
const PROFILE_TERMS = [
    "dacs",
    "railId",
    "jobId",
    "phaseIndex",
    "agreementHash",
    "buyer",
    "seller",
    "orchestrator",
    "payer",
]

function substrateSources(): string[] {
    return readdirSync(SUBSTRATE, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
        .map(e => join(SUBSTRATE, e.name))
}

describe("the generic substrate", () => {
    it("names no profile concept", () => {
        const offenders: string[] = []

        for (const path of substrateSources()) {
            const text = readFileSync(path, "utf8").toLowerCase()
            for (const term of PROFILE_TERMS) {
                if (text.includes(term.toLowerCase())) {
                    offenders.push(`${path.split("/").pop()}: ${term}`)
                }
            }
        }

        expect(offenders).toEqual([])
    })

    it("covers a meaningful amount of source", () => {
        // A boundary check over an empty set passes for the wrong reason.
        expect(substrateSources().length).toBeGreaterThanOrEqual(7)
    })
})

describe("a profile has to be registered to be executable", () => {
    it("refuses an intent naming a profile nobody registered", () => {
        expect(() =>
            validateOperationGraph({ profile: "not-registered-v1", operations: [] }),
        ).toThrow(OperationGraphError)
    })

    it("refuses an intent with no profile at all", () => {
        expect(() => validateOperationGraph({ operations: [] })).toThrow(
            /unknown atomic work profile/,
        )
    })

    it("knows the DACS profiles only once they are registered", () => {
        registerDacsAtomicWorkProfiles()

        expect(registeredAtomicWorkProfiles()).toContain("dacs-purchase-v1")
        expect(atomicWorkProfile("dacs-purchase-v1")?.operationGraph).toHaveLength(6)
        expect(atomicWorkProfile("dacs-completion-v1")?.operationGraph).toHaveLength(2)
    })

    it("is idempotent, so two callers registering it is not an error", () => {
        registerDacsAtomicWorkProfiles()
        registerDacsAtomicWorkProfiles()

        expect(registeredAtomicWorkProfiles()).toContain("dacs-completion-v1")
    })
})
