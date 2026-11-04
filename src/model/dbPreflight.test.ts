import { describe, expect, it } from "bun:test"
import { describeDbConnectionFailure } from "./dbPreflight"

const target = { host: "postgres.internal", port: 5432, database: "demos" }

describe("describeDbConnectionFailure", () => {
    it("names the host, port and database for an unresolvable host", () => {
        const error = Object.assign(
            new Error("getaddrinfo ENOTFOUND postgres.internal"),
            { code: "ENOTFOUND" },
        )
        const message = describeDbConnectionFailure(target, error)
        expect(message).toContain("postgres.internal:5432")
        expect(message).toContain("database \"demos\"")
        expect(message).toContain("absent or unreachable")
    })

    it("never carries the password", () => {
        // datasource.ts passes the whole database config, password included
        const password = "s3cret-pg-password"
        const message = describeDbConnectionFailure(
            { ...target, password } as typeof target,
            new Error("connect ECONNREFUSED 10.0.0.5:5432"),
        )
        expect(message).not.toContain(password)
        expect(message).toContain("absent or unreachable")
    })

    it("does not call a migration failure unreachable", () => {
        const message = describeDbConnectionFailure(
            target,
            new Error("relation \"blocks\" already exists"),
        )
        expect(message).toContain("postgres.internal:5432")
        expect(message).not.toContain("unreachable")
    })
})
