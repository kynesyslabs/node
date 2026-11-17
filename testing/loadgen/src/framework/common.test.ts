/**
 * errorShapeKey is the once-log key for errors whose messages embed nonces,
 * hashes or ids. Messages that differ only in those must share a key, so one
 * log line covers them. Text the peer chooses still makes new shapes, so
 * logNonCriticalErrorOnceCapped bounds how many keys are kept and logged (#708).
 * That text can also hold control characters, which must not reach the log raw,
 * and has no size limit, so the logger cuts each field and the whole record.
 *
 * Run this file in its own `bun test` process.
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
  textOrType,
  truncatedError,
} from "./common"

// C0 and C1 controls, DEL, the line and paragraph separators, and the bidi marks,
// embedding, override and isolate controls.
const RAW_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u{061c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u
// Characters that end a line for JavaScript and for many log viewers.
const LINE_BREAK = /\r\n|[\n\r\u{0085}\u{2028}\u{2029}]/u

describe("escapeControlChars", () => {
  it("shows C0/C1 controls, DEL, line separators and bidi controls as visible escapes", () => {
    expect(escapeControlChars("a\nb\rc\td")).toBe("a\\nb\\rc\\td")
    expect(escapeControlChars("\u0000\u001b[2K\u001f")).toBe("\\u0000\\u001b[2K\\u001f")
    expect(escapeControlChars("\u007f\u0080\u0085\u009b\u009f")).toBe("\\u007f\\u0080\\u0085\\u009b\\u009f")
    expect(escapeControlChars("\u{202a}\u{202e}\u{2066}\u{2069}")).toBe("\\u202a\\u202e\\u2066\\u2069")
    // Line and paragraph separators, then the left-to-right, right-to-left and Arabic letter marks.
    const separatorsAndMarks = "a\u{2028}[loadgen] forged\u{2029}b\u{200e}c\u{200f}d\u{061c}e"
    const escaped = escapeControlChars(separatorsAndMarks)
    expect(escaped).toBe("a\\u2028[loadgen] forged\\u2029b\\u200ec\\u200fd\\u061ce")
    expect(escaped).not.toMatch(RAW_CONTROL)
    expect(escaped.split(LINE_BREAK)).toHaveLength(1)
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
        "[loadgen] Non-critical error in test.sink: JSON Parse error: Unrecognized token '\\u001b' {\"value\":\"1\\u007f\\u009b\\u202e2\\n\"}",
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("escapes line and paragraph separators and the remaining bidi marks, one record per call", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      // JSON.stringify leaves U+2028, U+2029, U+200E, U+200F and U+061C raw in details.
      const forged = "\u{2028}[loadgen] Non-critical error in test.forged: ok\u{2029}\u{200e}\u{200f}\u{061c}"
      logNonCriticalError("test.separators", new Error(`rejected${forged}`), { memo: `x${forged}` })
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toMatch(RAW_CONTROL)
      expect(lines[0].split(LINE_BREAK)).toHaveLength(1)
      const shown = "\\u2028[loadgen] Non-critical error in test.forged: ok\\u2029\\u200e\\u200f\\u061c"
      expect(lines[0]).toBe(
        `[loadgen] Non-critical error in test.separators: rejected${shown} {"memo":"x${shown}"}`,
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
        odd: JSON.parse("{\"toString\":null}"),
        rpcUrls: ["http://node-1:53550", "http://node-2:53550"],
        workerId: 3,
        ok: true,
        balance: null,
      })
      expect(lines).toEqual([
        `[loadgen] Non-critical error in test.fields: bad amount {"amount":"${"7".repeat(500)}…(1000000 chars)",` +
          "\"big\":\"12\",\"odd\":\"object\",\"rpcUrls\":\"array(2) [string,string]\",\"workerId\":3,\"ok\":true,\"balance\":null}",
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
      logNonCriticalError("test.message", JSON.parse("{\"toString\":null}"))
      expect(lines).toEqual([
        `[loadgen] Non-critical error in test.message: ${"m".repeat(1_000)}…(5000 chars)`,
        "[loadgen] Non-critical error in test.message: object",
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("logs an object String() shows as [object Object] as a JSON-like preview, nested objects as their type", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      const cyclic: Record<string, unknown> = { id: 1 }
      cyclic.self = cyclic
      // A JSON-RPC error object thrown as is, and RPC values that are plain objects.
      logNonCriticalError("test.objects", { code: -32000, message: "nonce too low" }, {
        amount: { value: "5", decimals: 18 },
        big: { value: 12n },
        cyclic,
      })
      expect(lines).toEqual([
        "[loadgen] Non-critical error in test.objects: {\"code\":-32000,\"message\":\"nonce too low\"} " +
          String.raw`{"amount":"{\"value\":\"5\",\"decimals\":18}","big":"{\"value\":bigint}","cyclic":"{\"id\":1,\"self\":object}"}`,
      ])
      expect(errorShapeKey({ code: -32000, message: "nonce 17 too low" })).toBe("object:{\"code\":-#,\"message\":\"nonce # too low\"}")
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
      // The 2,000-character cut ends in the partial escape `\u00`, which is dropped.
      expect(kept).toHaveLength(1_996)
      expect(kept).toEndWith("\\u202e")
      expect(Number(total)).toBeGreaterThan(2_000)
      // The message is escaped before its own cut, so its marker survives the record cut.
      expect(lines[0]).toContain(`: ${escapeControlChars(controls.slice(0, 166))}…(600 chars) {"a":`)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("never ends the record cut inside an escape", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    const prefix = "[loadgen] Non-critical error in "
    const nel = "\\u0085"
    try {
      // Each U+0085 is written as the 6-character escape \u0085. Context lengths 0 to 5
      // characters apart put the 2,000-character cut after each of `\`, `\u`, `\u0`,
      // `\u00`, `\u008` and a whole escape.
      const contexts = ["", "x", "xx", "xxx", "xxxx", "xxxxx"].map(pad => `test.recordescape${pad}`)
      for (const context of contexts) {
        logNonCriticalError(context, "bad", { a: "\u0085".repeat(500), b: "\u0085".repeat(500) })
      }
      expect(lines).toHaveLength(6)
      contexts.forEach((context, i) => {
        const start = `${prefix}${context}: bad {"a":"`
        const whole = Math.floor((2_000 - start.length) / 6)
        const total = start.length + 3_000 + "\",\"b\":\"".length + 3_000 + "\"}".length
        expect(lines[i]).toBe(`${start}${nel.repeat(whole)}…(${total} chars)`)
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("keeps an escaped backslash whole at the record cut", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    const prefix = "[loadgen] Non-critical error in "
    try {
      // JSON writes each backslash as `\\`. One context puts the cut after a whole `\\`,
      // the other between its two characters.
      const contexts = ["test.pairs", "test.pairsx"]
      for (const context of contexts) {
        logNonCriticalError(context, "bad", { a: "\\".repeat(500), b: "\\".repeat(500) })
      }
      contexts.forEach((context, i) => {
        const start = `${prefix}${context}: bad {"a":"${"\\".repeat(1_000)}","b":"`
        const keptB = 2_000 - start.length - ((2_000 - start.length) % 2)
        expect(lines[i]).toBe(`${start}${"\\".repeat(keptB)}…(${start.length + 1_000 + 2} chars)`)
      })
      expect(new Set(contexts.map(context => (2_000 - prefix.length - context.length) % 2)).size).toBe(2)
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

  it("never splits a surrogate pair when it cuts the message, a details value or the record", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    // A high surrogate not followed by a low one, or a low one not preceded by a high one
    // (no u flag, so the class matches UTF-16 code units).
    const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    const prefix = "[loadgen] Non-critical error in "
    try {
      // In each case the cut falls between the two code units of 😀 (😀).
      logNonCriticalError("test.surrogate", `${"a".repeat(999)}😀tail`)
      logNonCriticalError("test.surrogate", "bad", { value: `${"a".repeat(499)}😀tail` })
      const context = `${"a".repeat(1_999 - prefix.length)}😀tail`
      logNonCriticalError(context, "bad")
      expect(lines).toEqual([
        `${prefix}test.surrogate: ${"a".repeat(999)}…(1005 chars)`,
        `${prefix}test.surrogate: bad {"value":"${"a".repeat(499)}…(505 chars)"}`,
        `${prefix}${"a".repeat(1_999 - prefix.length)}…(${prefix.length + context.length + ": bad".length} chars)`,
      ])
      for (const line of lines) expect(line).not.toMatch(LONE_SURROGATE)
      // A pair that ends before the cap is kept whole.
      expect(truncatedError(new Error(`${"a".repeat(498)}😀tail`)).message).toBe(`${"a".repeat(498)}😀…(504 chars)`)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("drops a lone high surrogate at the cut and keeps a lone low one", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    const prefix = "[loadgen] Non-critical error in test.lone: "
    try {
      // The last kept unit is a high surrogate with no low surrogate after it ("t"
      // follows), so the cut keeps one unit fewer, as it does for a whole pair.
      logNonCriticalError("test.lone", `${"a".repeat(999)}\ud83dtail`)
      logNonCriticalError("test.lone", "bad", { value: `${"a".repeat(499)}\ud83dtail` })
      // A low surrogate is never the first half of a pair, so it is kept.
      logNonCriticalError("test.lone", `${"a".repeat(999)}\ude00tail`)
      expect(lines).toEqual([
        `${prefix}${"a".repeat(999)}…(1004 chars)`,
        `${prefix}bad {"value":"${"a".repeat(499)}…(504 chars)"}`,
        `${prefix}${"a".repeat(999)}\ude00…(1004 chars)`,
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("textOrType", () => {
  it("previews a large, deeply nested RPC object without serializing nested values", () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 10_000; i++) deep = { child: deep }
    let toJsonCalls = 0
    const nested = { toJSON: () => { toJsonCalls++; return "serialized" }, deep }
    const value = { id: 7, memo: "x".repeat(1_000_000), nested, deep }
    const stringifySpy = spyOn(JSON, "stringify")
    let text: string
    let stringifyArgs: unknown[]
    try {
      text = textOrType(value)
      stringifyArgs = stringifySpy.mock.calls.map(call => call[0])
    } finally {
      stringifySpy.mockRestore()
    }
    expect(toJsonCalls).toBe(0)
    // Only cut keys and string values (at most 80 characters) are ever quoted.
    expect(stringifyArgs.length).toBeGreaterThan(0)
    for (const arg of stringifyArgs) {
      expect(typeof arg).toBe("string")
      expect((arg as string).length).toBeLessThanOrEqual(80)
    }
    expect(text.length).toBeLessThan(1_000)
    expect(text).toBe(`{"id":7,"memo":"${"x".repeat(80)}"…(1000000 chars),"nested":object,"deep":object}`)
  })

  it("bounds arrays, key counts and key names, and logs the type when a getter throws", () => {
    expect(textOrType(["a", 1, null, {}, [], 2n, undefined])).toBe("array(7) [string,number,null,object,array,bigint,undefined]")
    expect(textOrType(Array.from({ length: 25 }, (_, i) => i))).toBe(`array(25) [${Array(20).fill("number").join(",")},…]`)
    const wide = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]))
    expect(textOrType(wide)).toBe(`{${Array.from({ length: 20 }, (_, i) => `"k${i}":${i}`).join(",")},…(more keys)}`)
    expect(textOrType({ ["k".repeat(200)]: false })).toBe(`{"${"k".repeat(80)}"…(200 chars):false}`)
    expect(textOrType({ get amount() { throw new Error("getter") } })).toBe("object")
  })

  it("keeps String() for strings, numbers and objects with their own toString", () => {
    expect(textOrType("12")).toBe("12")
    expect(textOrType(12n)).toBe("12")
    expect(textOrType({ toString: () => "status 503" })).toBe("status 503")
    expect(textOrType(new Error("boom"))).toBe("Error: boom")
    expect(textOrType(JSON.parse("{\"toString\":null}"))).toBe("object")
    // A small flat object reads the same as its JSON.
    expect(textOrType({ amount: "5", decimals: 18, ok: true, owner: null })).toBe("{\"amount\":\"5\",\"decimals\":18,\"ok\":true,\"owner\":null}")
  })

  it("shows null and undefined as text, and only primitives' text inside a preview", () => {
    expect(textOrType(null)).toBe("null")
    expect(textOrType(undefined)).toBe("undefined")
    const fields = { u: undefined, n: Number.NaN, f: 1.5, b: false, big: 1n, sym: Symbol("s"), fn: () => 1, a: [1], o: { x: 1 } }
    expect(textOrType(fields)).toBe(
      "{\"u\":undefined,\"n\":NaN,\"f\":1.5,\"b\":false,\"big\":bigint,\"sym\":symbol,\"fn\":function,\"a\":array,\"o\":object}",
    )
  })

  it("never splits a surrogate pair when it cuts a preview string at 80 characters", () => {
    // The 80-character cut falls between the two code units of 😀; with a plain slice the
    // lone high surrogate reached JSON.stringify, which writes it as the escape \ud83d.
    const preview = textOrType({ memo: "1".repeat(79) + "😀" + "tail" })
    expect(preview).toBe(`{"memo":"${"1".repeat(79)}"…(85 chars)}`)
    expect(preview).not.toContain("\\ud83d")
    expect(preview).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    // A key is cut the same way.
    expect(textOrType({ ["k".repeat(79) + "😀"]: 1 })).toBe(`{"${"k".repeat(79)}"…(81 chars):1}`)
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
      expect(lines[0]).toContain("{\"rpcUrl\":\"http://node-1:53550\",\"workerId\":3}")
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
          " {\"rpcUrl\":\"http://node-1:53550\",\"workerId\":4}",
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

  it("cuts and escapes exactly as the per-character loop did", () => {
    // Copies of headOf and of the loop cutEscaped used before it escaped the kept head
    // in one call. truncatedError(text, maxChars).message is cutEscaped(text, maxChars).
    const loopHeadOf = (text: string, maxChars: number) => {
      const head = text.slice(0, maxChars)
      const last = head.codePointAt(head.length - 1) ?? 0
      const splitsPair = text.length > maxChars && last >= 0xd800 && last <= 0xdbff
      return splitsPair ? head.slice(0, -1) : head
    }
    const loopCutEscaped = (text: string, maxChars: number) => {
      let shown = ""
      for (const char of loopHeadOf(text, maxChars)) {
        const escaped = escapeControlChars(char)
        if (shown.length + escaped.length > maxChars) return `${shown}…(${text.length} chars)`
        shown += escaped
      }
      return text.length > maxChars ? `${shown}…(${text.length} chars)` : shown
    }

    for (const maxChars of [500, 1_000]) {
      // Escaped head of exactly maxChars: 10 two-character and 10 six-character escapes.
      const exact = "\n".repeat(10) + "\u001b".repeat(10) + "a".repeat(maxChars - 80)
      expect(escapeControlChars(exact)).toHaveLength(maxChars)
      expect(truncatedError(exact, maxChars).message).toBe(escapeControlChars(exact))
      const inputs = [
        "",
        "short ASCII text",
        "a".repeat(maxChars),
        "a".repeat(maxChars + 1),
        "a".repeat(999) + "😀" + "tail",
        "a".repeat(maxChars - 2) + "😀" + "tail",
        "a".repeat(maxChars - 1) + "\ud83d",
        "\u0085".repeat(500),
        "[Confirm] rejected:\n\r\t\u001b\u007f\u0085‮ 😀 ".repeat(60),
        "a".repeat(maxChars) + "\n\u001b",
        "a".repeat(maxChars - 3) + "\u001b".repeat(3),
        "\n" + "a".repeat(maxChars - 1),
        exact,
        exact + "\u001b",
      ]
      for (const text of inputs) {
        const message = truncatedError(text, maxChars).message
        expect({ maxChars, text, message }).toEqual({ maxChars, text, message: loopCutEscaped(text, maxChars) })
      }
    }
  })

  it("escapes a head that fits the cap in one pass", () => {
    // escapeControlChars is one String.prototype.replace call; the per-character loop
    // made one call per kept character.
    const replaceSpy = spyOn(String.prototype, "replace")
    let message = ""
    let replaceCalls = 0
    try {
      message = truncatedError(new Error("x".repeat(600))).message
      replaceCalls = replaceSpy.mock.calls.length
    } finally {
      replaceSpy.mockRestore()
    }
    expect(message).toBe(`${"x".repeat(500)}…(600 chars)`)
    expect(replaceCalls).toBe(1)
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
      badName.name = JSON.parse("{\"toString\":null}")

      // Same calls as the transfer_loadgen worker's catch; before the guard both threw "No default value".
      const bare = truncatedError(Object.create(null))
      logNonCriticalErrorOnceCapped("test.oddworker", 50, errorShapeKey(bare), bare, { workerId: 6 })
      const named = truncatedError(badName)
      logNonCriticalErrorOnceCapped("test.oddworker", 50, errorShapeKey(named), named, { workerId: 7 })

      expect([bare.name, bare.message]).toEqual(["object", "object"])
      expect([named.name, named.message]).toEqual(["object", "rejected"])
      expect(lines).toEqual([
        "[loadgen] Non-critical error in test.oddworker: object {\"workerId\":6}",
        "[loadgen] Non-critical error in test.oddworker: rejected {\"workerId\":7}",
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("logs the type when reading the error's message or name throws", () => {
    const lines: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    const throwingGetter = (what: string) => ({
      get() {
        throw new Error(`${what} getter`)
      },
    })
    try {
      const badMessage = new Error("hidden")
      Object.defineProperty(badMessage, "message", throwingGetter("message"))
      const badName = new Error("visible")
      Object.defineProperty(badName, "name", throwingGetter("name"))
      const trapped = new Proxy(new Error("proxied"), throwingGetter("proxy"))

      // Before the guard, each case threw out of the logger or of the worker's catch.
      const results = [badMessage, badName, trapped].map((error, workerId) => {
        const before = lines.length
        logNonCriticalError("test.badprops", error, { workerId })
        const loggedOnce = lines.length - before === 1
        const cut = truncatedError(error)
        logNonCriticalErrorOnceCapped("test.badpropsworker", 50, errorShapeKey(cut), cut, { workerId })
        return [loggedOnce, cut.name, cut.message, errorShapeKey(error)]
      })

      expect(results).toEqual([
        [true, "Error", "object", "Error:object"],
        [true, "object", "visible", "object:visible"],
        [true, "object", "object", "object:object"],
      ])
      expect(lines).toEqual([
        "[loadgen] Non-critical error in test.badprops: object {\"workerId\":0}",
        "[loadgen] Non-critical error in test.badpropsworker: object {\"workerId\":0}",
        "[loadgen] Non-critical error in test.badprops: visible {\"workerId\":1}",
        "[loadgen] Non-critical error in test.badpropsworker: visible {\"workerId\":1}",
        "[loadgen] Non-critical error in test.badprops: object {\"workerId\":2}",
        "[loadgen] Non-critical error in test.badpropsworker: object {\"workerId\":2}",
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
