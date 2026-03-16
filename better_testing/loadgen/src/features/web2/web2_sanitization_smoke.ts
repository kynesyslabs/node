import {
  sanitizeWeb2RequestForLogging,
  sanitizeWeb2RequestForStorage,
} from "../../../../../src/features/web2/sanitizeWeb2Request"
import { createSampleWeb2Request, writeWeb2Summary } from "./shared"

export async function runWeb2SanitizationSmoke() {
  const original = createSampleWeb2Request()
  const forLogging = sanitizeWeb2RequestForLogging(original)
  const forStorage = sanitizeWeb2RequestForStorage(original)

  const loggingHeaders = forLogging.raw?.headers ?? {}
  const storageHeaders = forStorage.raw?.headers ?? {}
  const originalHeaders = original.raw?.headers ?? {}

  const checks = {
    loggingRedactsAuthorization: loggingHeaders.Authorization === "[redacted]",
    loggingRedactsCookieArray: Array.isArray(loggingHeaders.Cookie) && loggingHeaders.Cookie.every((value: string) => value === "[redacted]"),
    loggingKeepsCustomHeader: loggingHeaders["X-Custom"] === "keep-me",
    storageStripsAuthorization: loggingHeaders.Authorization !== originalHeaders.Authorization && !("Authorization" in storageHeaders),
    storageStripsCookie: !("Cookie" in storageHeaders),
    storageKeepsContentType: storageHeaders["Content-Type"] === "application/json",
    originalUnchanged: originalHeaders.Authorization === "Bearer secret-token"
      && Array.isArray(originalHeaders.Cookie)
      && originalHeaders.Cookie[0] === "sid=abc",
    metadataPreserved: forStorage.hash === original.hash
      && forStorage.signature === original.signature
      && (forLogging.raw as any)?.body === (original.raw as any)?.body,
  }

  const ok = Object.values(checks).every(Boolean)
  const summary = {
    scenario: "web2_sanitization_smoke",
    ok,
    checks,
    originalHeaders,
    loggingHeaders,
    storageHeaders,
    timestamp: new Date().toISOString(),
  }

  writeWeb2Summary("web2_sanitization_smoke.summary.json", summary)
  console.log(JSON.stringify({ web2_sanitization_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("web2_sanitization_smoke failed: sanitizer behavior did not match expectations")
  }
}

if (import.meta.main) {
  await runWeb2SanitizationSmoke()
}
