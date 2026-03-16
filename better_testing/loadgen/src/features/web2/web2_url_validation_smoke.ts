import { validateAndNormalizeHttpUrl } from "../../../../../src/features/web2/validator"
import { writeWeb2Summary } from "./shared"

type ValidationCase = {
  label: string
  input: string
  ok: boolean
  normalizedUrl?: string
  status?: number
  messageIncludes?: string
}

export async function runWeb2UrlValidationSmoke() {
  const cases: ValidationCase[] = [
    {
      label: "canonicalizes_https_default_port_and_fragment",
      input: "HTTPS://Example.COM:443/path?q=1#frag",
      ok: true,
      normalizedUrl: "https://example.com/path?q=1",
    },
    {
      label: "canonicalizes_http_default_port",
      input: "http://Example.com:80/api",
      ok: true,
      normalizedUrl: "http://example.com/api",
    },
    {
      label: "rejects_localhost",
      input: "http://localhost:3000",
      ok: false,
      status: 400,
      messageIncludes: "Localhost targets are not allowed",
    },
    {
      label: "rejects_private_ipv4",
      input: "http://10.0.0.8/test",
      ok: false,
      status: 400,
      messageIncludes: "Private, link-local, or loopback targets are not allowed",
    },
    {
      label: "rejects_loopback_ipv4",
      input: "http://127.0.0.1/admin",
      ok: false,
      status: 400,
      messageIncludes: "Private, link-local, or loopback targets are not allowed",
    },
    {
      label: "rejects_embedded_credentials",
      input: "https://user:pass@example.com/path",
      ok: false,
      status: 400,
      messageIncludes: "embedded credentials",
    },
    {
      label: "rejects_invalid_scheme",
      input: "ftp://example.com/file",
      ok: false,
      status: 400,
      messageIncludes: "Only http(s) are allowed",
    },
  ]

  const results = cases.map(testCase => {
    const result = validateAndNormalizeHttpUrl(testCase.input)
    const r = result as any
    const ok = (
      result.ok === testCase.ok
      && (testCase.ok
        ? r.normalizedUrl === testCase.normalizedUrl
        : r.status === testCase.status
          && typeof r.message === "string"
          && r.message.includes(testCase.messageIncludes ?? ""))
    )

    return {
      ...testCase,
      actual: result,
      ok,
    }
  })

  const ok = results.every(result => result.ok)
  const summary = {
    scenario: "web2_url_validation_smoke",
    ok,
    cases: results,
    timestamp: new Date().toISOString(),
  }

  writeWeb2Summary("web2_url_validation_smoke.summary.json", summary)
  console.log(JSON.stringify({ web2_url_validation_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("web2_url_validation_smoke failed: validation results did not match expectations")
  }
}

if (import.meta.main) {
  await runWeb2UrlValidationSmoke()
}
