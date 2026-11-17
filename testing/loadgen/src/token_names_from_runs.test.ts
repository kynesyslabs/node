/**
 * listTokenAddressesFromRuns skips a summary file it cannot read. That skip must
 * still happen, and the read error must show up in the log with the file (#708).
 *
 * Run this file in its own `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

mock.module("@kynesyslabs/demosdk/websdk", () => ({ Demos: class {} }))

const { listTokenAddressesFromRuns } = await import("./token_names_from_runs")

const GOOD = "0x" + "1".repeat(64)
const BAD = "0x" + "2".repeat(64)

describe("token_names_from_runs listTokenAddressesFromRuns", () => {
  let runsDir: string
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fileSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-names-runs-"))
    fs.mkdirSync(path.join(runsDir, "run1"))
    fs.writeFileSync(path.join(runsDir, "run1", "good.summary.json"), JSON.stringify({ tokenAddress: GOOD }))
    fs.writeFileSync(path.join(runsDir, "run1", "bad.summary.json"), JSON.stringify({ tokenAddress: BAD }))
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    const realFile = Bun.file.bind(Bun)
    fileSpy = spyOn(Bun, "file").mockImplementation(((target: string) => {
      if (String(target).endsWith("bad.summary.json")) {
        return { text: () => Promise.reject(new Error("EACCES: permission denied, open")) }
      }
      return realFile(target)
    }) as any)
  })

  afterEach(() => {
    fileSpy.mockRestore()
    errorSpy.mockRestore()
    fs.rmSync(runsDir, { recursive: true, force: true })
  })

  it("skips an unreadable summary and logs the error with its path", async () => {
    expect(await listTokenAddressesFromRuns(runsDir)).toEqual([GOOD])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("[loadgen] Non-critical error in token_names_from_runs.listTokenAddressesFromRuns")
    expect(errors[0]).toContain("EACCES: permission denied, open")
    expect(errors[0]).toContain(JSON.stringify({ file: path.join(runsDir, "run1", "bad.summary.json") }))
  })
})
