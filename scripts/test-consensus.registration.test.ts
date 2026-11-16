import { expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

it("runs the RapidAPI configuration and Twitter request regressions in CI", () => {
    const files = execFileSync("bash", [join(import.meta.dir, "test-consensus.sh"), "--list"], {
        encoding: "utf8",
    }).trim().split("\n")

    expect(files).toContain("src/config/loader.rapidApi.test.ts")
    expect(files).toContain("src/libs/identity/tools/twitter.request.test.ts")
})
