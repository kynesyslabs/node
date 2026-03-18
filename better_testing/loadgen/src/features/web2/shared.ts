import { getRunConfig, writeJson } from "../../framework/io"

export function createSampleWeb2Request(overrides: Record<string, any> = {}): any {
  const base = {
    raw: {
      action: "START_PROXY",
      url: "https://example.com/api",
      headers: {
        Authorization: "Bearer secret-token",
        Cookie: ["sid=abc", "pref=dark"],
        "Content-Type": "application/json",
        "X-Custom": "keep-me",
      },
      body: "{\"hello\":\"world\"}",
    },
    result: undefined,
    hash: "sample-hash",
    signature: "sample-signature",
  }

  return {
    ...base,
    ...overrides,
    raw: {
      ...base.raw,
      ...(overrides.raw ?? {}),
      headers: {
        ...base.raw.headers,
        ...(overrides.raw?.headers ?? {}),
      },
    },
  }
}

export function writeWeb2Summary(fileName: string, summary: Record<string, any>) {
  const run = getRunConfig()
  writeJson(`${run.runDir}/features/web2/${fileName}`, summary)
}

export function serializeError(error: unknown) {
  const err = error as any
  return {
    message: err?.message ?? String(error),
    status: err?.status,
  }
}
