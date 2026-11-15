/**
 * errorShapeKey is the once-log key for errors whose messages embed nonces,
 * hashes or ids. Messages that differ only in those must share a key, so one
 * log line covers them. Text the peer chooses still makes new shapes, so
 * logNonCriticalErrorOnceCapped bounds how many keys are kept and logged (#708).
 * That text can also hold control characters, which must not reach the log raw,
 * and has no size limit, so the logger cuts each field and the whole record.
 */

import { describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  errorShapeKey,
  escapeControlChars,
  loggedNonCriticalKeyCount,
  logNonCriticalError,
  logNonCriticalErrorOnceCapped,
  truncatedError,
} from "./common"

// C0 and C1 controls, DEL and the bidi embedding, override and isolate controls.
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]/u

describe("escapeControlChars", () => {
  it("shows C0/C1 controls, DEL and bidi controls as visible escapes", () => {
    expect(escapeControlChars("a\nb\rc\td")).toBe("a\\nb\\rc\\td")
    expect(escapeControlChars("\u0000\u001b[2K\u001f")).toBe("\\u0000\\u001b[2K\\u001f")
    expect(escapeControlChars("\u007f\u0080\u0085\u009b\u009f")).toBe("\\u007f\\u0080\\u0085\\u009b\\u009f")
    expect(escapeControlChars("\u{202a}\u{202e}\u{2066}\u{2069}")).toBe("\\u202a\\u202e\\u2066\\u2069")
  })

  it("leaves printable text unchanged", () => {
    // NBSP, e-acute, ellipsis, narrow NBSP and superscript zero sit next to the escaped ranges.
    const printable = " ~\u{a0}\u{e9}\u{2026}\u{202f}\u{2070} 0xAbC [loadgen] \\n {\"a\":1}"
    expect(escapeControlChars(printable)).toBe(printable)
  })
})

describe("logNonCriticalError", () => {
  it("escapes controls in the message and in details that JSON.stringify leaves raw", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      // Bun's JSON.parse error quotes the offending body character; details carry RPC values.
      logNonCriticalError("test.sink", new Error("JSON Parse error: Unrecognized token '\u001b'"), {
        value: "1\u007f\u009b\u{202e}2\n",
      })
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toMatch(RAW_CONTROL)
      expect(lines[0]).toBe(
        `[loadgen] Non-critical error in test.sink: JSON Parse error: Unrecognized token '\\u001b' {"value":"1\\u007f\\u009b\\u202e2\\n"}`,
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("cuts each details value to 500 characters and logs bigint, nested and String()-throwing values", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      logNonCriticalError("test.fields", new Error("bad amount"), {
        amount: "7".repeat(1_000_000),
        big: 12n,
        odd: JSON.parse('{"toString":null}'),
        rpcUrls: ["http://node-1:53550", "http://node-2:53550"],
        workerId: 3,
        ok: true,
        balance: null,
      })
      expect(lines).toEqual([
        `[loadgen] Non-critical error in test.fields: bad amount {"amount":"${"7".repeat(500)}…(1000000 chars)",` +
          `"big":"12","odd":"object","rpcUrls":"http://node-1:53550,http://node-2:53550","workerId":3,"ok":true,"balance":null}`,
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("cuts the message to 1,000 characters and logs the type of an error String() rejects", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      logNonCriticalError("test.message", new Error("m".repeat(5_000)))
      logNonCriticalError("test.message", JSON.parse('{"toString":null}'))
      expect(lines).toEqual([
        `[loadgen] Non-critical error in test.message: ${"m".repeat(1_000)}…(5000 chars)`,
        "[loadgen] Non-critical error in test.message: object",
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("cuts the escaped record to 2,000 characters", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      // Each control character is written as a 6-character escape, so cut fields still grow.
      const controls = "\u0001\u007f\u{202e}".repeat(200)
      logNonCriticalError("test.record", new Error(controls), { a: controls, b: controls, c: controls })
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toMatch(RAW_CONTROL)
      expect(lines[0]).toStartWith("[loadgen] Non-critical error in test.record: \\u0001\\u007f\\u202e")
      const [, kept, total] = lines[0].match(/^([\s\S]*)…\((\d+) chars\)$/) ?? []
      expect(kept).toHaveLength(2_000)
      expect(Number(total)).toBeGreaterThan(2_000)
      // The message is escaped before its own cut, so its marker survives the record cut.
      expect(lines[0]).toContain(`: ${escapeControlChars(controls.slice(0, 166))}…(600 chars) {"a":`)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("keeps the original length in the message marker when escaping makes the message longer", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      // 5,000 ESC characters escape to 30,000; whole escapes fill the 1,000-character cap.
      logNonCriticalError("test.escmessage", new Error("\u001b".repeat(5_000)))
      expect(lines).toEqual([`[loadgen] Non-critical error in test.escmessage: ${"\\u001b".repeat(166)}…(5000 chars)`])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("errorShapeKey", () => {
  it("groups messages that differ only in numbers, hex runs and ids", () => {
    const a = errorShapeKey(new Error("nonce 17 too low for 0xAbC123 (tx 9f8e7d6c5b4a39281706)"))
    const b = errorShapeKey(new Error("nonce 4021 too low for 0xdef4567890 (tx 0123456789abcdef0123)"))
    expect(a).toBe(b)
    expect(a).toBe("Error:nonce # too low for # (tx #)")

    expect(errorShapeKey(new Error("request 550e8400-e29b-41d4-a716-446655440000 failed")))
      .toBe(errorShapeKey(new Error("request 123e4567-e89b-12d3-a456-426614174000 failed")))
  })

  it("keeps the error name and plain words apart", () => {
    expect(errorShapeKey(new TypeError("bad value"))).not.toBe(errorShapeKey(new RangeError("bad value")))
    expect(errorShapeKey(new Error("decade added"))).toBe("Error:decade added")
    expect(errorShapeKey("plain 42")).toBe("string:plain #")
    expect(errorShapeKey({ name: "RpcError", toString: () => "status 503" })).toBe("RpcError:status #")
  })

  it("caps the key at 200 characters", () => {
    expect(errorShapeKey(new Error("x".repeat(500)))).toHaveLength(200)
  })
})

describe("logNonCriticalErrorOnceCapped", () => {
  it("keeps and logs at most the budget of distinct keys, then logs one line", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      const budget = 50
      // Alphabetic words survive errorShapeKey, like the text a peer puts in a confirm rejection.
      const word = (i: number) => [...i.toString(26)].map(c => String.fromCharCode(97 + parseInt(c, 26))).join("")
      const errors = Array.from({ length: 1000 }, (_, i) =>
        new Error(`[Confirm] Transaction is not valid: rejected ${word(i)}`))
      expect(new Set(errors.map(errorShapeKey)).size).toBe(1000)

      const keysBefore = loggedNonCriticalKeyCount()
      for (const error of errors) {
        logNonCriticalErrorOnceCapped("test.worker", budget, errorShapeKey(error), error, { workerId: 1 })
      }

      expect(loggedNonCriticalKeyCount() - keysBefore).toBe(budget)
      expect(lines).toHaveLength(budget + 1)
      expect(lines[0]).toContain("Non-critical error in test.worker: [Confirm] Transaction is not valid: rejected a")
      expect(lines[budget]).toContain(`${budget} distinct errors logged; further distinct errors are counted but not logged`)

      // Logged shapes stay deduped and new shapes stay silent once the budget is used.
      logNonCriticalErrorOnceCapped("test.worker", budget, errorShapeKey(errors[0]), errors[0])
      logNonCriticalErrorOnceCapped("test.worker", budget, "Error:another new shape", new Error("another new shape"))
      expect(lines).toHaveLength(budget + 1)
      expect(loggedNonCriticalKeyCount() - keysBefore).toBe(budget)

      // The budget is per context.
      logNonCriticalErrorOnceCapped("test.other", budget, "Error:first", new Error("first"))
      expect(lines).toHaveLength(budget + 2)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("truncatedError", () => {
  it("keeps the worker log line under 1 KB for a 1,000,000-character peer message", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      const prefix = "[Confirm] Transaction is not valid: "
      const error = new Error(prefix + "z".repeat(1_000_000 - prefix.length))
      expect(error.message).toHaveLength(1_000_000)

      // Same calls as the transfer_loadgen worker's catch.
      const cut = truncatedError(error)
      logNonCriticalErrorOnceCapped("test.bigworker", 50, errorShapeKey(cut), cut, { rpcUrl: "http://node-1:53550", workerId: 3 })

      expect(cut.message).toBe(`${prefix}${"z".repeat(500 - prefix.length)}…(1000000 chars)`)
      expect(lines).toHaveLength(1)
      expect(lines[0].length).toBeLessThan(1024)
      expect(lines[0]).toContain("…(1000000 chars)")
      expect(lines[0]).toContain(`{"rpcUrl":"http://node-1:53550","workerId":3}`)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("logs a peer message that forges a loadgen line as one line with no raw control characters", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      const forged = "\n[loadgen] Non-critical error in transfer_loadgen.worker: all transfers succeeded"
      const error = new Error(`[Confirm] Transaction is not valid: rejected${forged}\r\u001b[2K\u{202e}ok\u0085\u007f`)

      // Same calls as the transfer_loadgen worker's catch.
      const cut = truncatedError(error)
      const key = errorShapeKey(cut)
      logNonCriticalErrorOnceCapped("test.forgedworker", 50, key, cut, { rpcUrl: "http://node-1:53550", workerId: 4 })

      expect(lines).toHaveLength(1)
      expect(lines[0].split(/\r|\n/)).toHaveLength(1)
      expect(lines[0]).not.toMatch(RAW_CONTROL)
      expect(key).not.toMatch(RAW_CONTROL)
      expect(lines[0]).toBe(
        "[loadgen] Non-critical error in test.forgedworker: [Confirm] Transaction is not valid: rejected" +
          "\\n[loadgen] Non-critical error in transfer_loadgen.worker: all transfers succeeded" +
          "\\r\\u001b[2K\\u202eok\\u0085\\u007f" +
          ` {"rpcUrl":"http://node-1:53550","workerId":4}`,
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("escapes before the cut, so the copy fits the cap and the marker gives the original length", () => {
    const cut = truncatedError(new Error("\n".repeat(600)))
    expect(cut.message).toBe(`${"\\n".repeat(250)}…(600 chars)`)
    expect(cut.message).not.toMatch(RAW_CONTROL)
  })

  it("logs a confirm rejection of 600 ESC characters as one record with the original length marker", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      const prefix = "[Confirm] Transaction is not valid: "
      const error = new Error(prefix + "\u001b".repeat(600))
      expect(error.message).toHaveLength(636)

      // Same calls as the transfer_loadgen worker's catch.
      const cut = truncatedError(error)
      logNonCriticalErrorOnceCapped("test.escworker", 50, errorShapeKey(cut), cut, { rpcUrl: "http://node-1:53550", workerId: 5 })

      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toMatch(RAW_CONTROL)
      expect(lines[0].match(/…\(\d+ chars\)/g)).toEqual(["…(636 chars)"])
      // 36 + 77 * 6 = 498 characters of whole escapes, then the marker.
      expect(cut.message).toBe(`${prefix}${"\\u001b".repeat(77)}…(636 chars)`)
      expect(lines[0]).toBe(
        `[loadgen] Non-critical error in test.escworker: ${cut.message} {"rpcUrl":"http://node-1:53550","workerId":5}`,
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("derives the shape key from the cut text", () => {
    // One digit run: the full message collapses to a single "#", the cut copy keeps its marker.
    const error = new Error("7".repeat(1_000_000))
    expect(errorShapeKey(error)).toBe("Error:#")
    expect(errorShapeKey(truncatedError(error))).toBe("Error:#…(# chars)")
  })

  it("leaves short errors and their shape keys unchanged", () => {
    const typeError = truncatedError(new TypeError("bad value"))
    expect(typeError.name).toBe("TypeError")
    expect(typeError.message).toBe("bad value")
    expect(truncatedError(new Error("y".repeat(500))).message).toBe("y".repeat(500))
    expect(truncatedError(new Error("y".repeat(501))).message).toBe(`${"y".repeat(500)}…(501 chars)`)

    const samples: unknown[] = [
      new Error("nonce 17 too low for 0xAbC123"),
      new RangeError("bad value"),
      "plain 42",
      { name: "RpcError", toString: () => "status 503" },
      null,
    ]
    for (const sample of samples) {
      expect(errorShapeKey(truncatedError(sample))).toBe(errorShapeKey(sample))
    }
  })

  it("logs the type when String() throws on the thrown value or its name", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      const badName = new Error("rejected")
      badName.name = JSON.parse('{"toString":null}')

      // Same calls as the transfer_loadgen worker's catch; before the guard both threw "No default value".
      const bare = truncatedError(Object.create(null))
      logNonCriticalErrorOnceCapped("test.oddworker", 50, errorShapeKey(bare), bare, { workerId: 6 })
      const named = truncatedError(badName)
      logNonCriticalErrorOnceCapped("test.oddworker", 50, errorShapeKey(named), named, { workerId: 7 })

      expect([bare.name, bare.message]).toEqual(["object", "object"])
      expect([named.name, named.message]).toEqual(["object", "rejected"])
      expect(lines).toEqual([
        `[loadgen] Non-critical error in test.oddworker: object {"workerId":6}`,
        `[loadgen] Non-critical error in test.oddworker: rejected {"workerId":7}`,
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("is what the transfer_loadgen worker keys and logs", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, "../transfer_loadgen.ts"), "utf8")
    const calls = source.match(/logNonCriticalErrorOnceCapped\([^\n]*/g) ?? []
    expect(calls).toHaveLength(1)
    expect(source.includes("const cut = truncatedError(error)")).toBe(true)
    expect(calls[0]).toContain("errorShapeKey(cut), cut,")
  })
})
