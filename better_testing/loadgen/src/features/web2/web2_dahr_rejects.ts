import { handleWeb2 } from "../../../../../src/features/web2/handleWeb2"
import { createSampleWeb2Request, serializeError, writeWeb2Summary } from "./shared"

type RejectCase = {
  label: string
  url: string
  messageIncludes: string
}

export async function runWeb2DahrRejects() {
  const created = await handleWeb2(createSampleWeb2Request())
  if (typeof created === "string") {
    throw new Error(`web2_dahr_rejects failed to create DAHR: ${created}`)
  }

  const cases: RejectCase[] = [
    {
      label: "rejects_localhost_target",
      url: "http://localhost:8080",
      messageIncludes: "Localhost targets are not allowed",
    },
    {
      label: "rejects_loopback_ip",
      url: "http://127.0.0.1/admin",
      messageIncludes: "Private, link-local, or loopback targets are not allowed",
    },
    {
      label: "rejects_private_ipv4",
      url: "http://192.168.1.2/secret",
      messageIncludes: "Private, link-local, or loopback targets are not allowed",
    },
    {
      label: "rejects_embedded_credentials",
      url: "https://user:pass@example.com/private",
      messageIncludes: "embedded credentials",
    },
  ]

  const results = []
  for (const testCase of cases) {
    try {
      await created.startProxy({
        method: "GET" as any,
        headers: {},
        payload: undefined,
        authorization: undefined,
        url: testCase.url,
      })
      results.push({
        ...testCase,
        ok: false,
        actual: { message: "unexpected success", status: undefined },
      })
    } catch (error) {
      const actual = serializeError(error)
      results.push({
        ...testCase,
        actual,
        ok: actual.status === 400 && actual.message.includes(testCase.messageIncludes),
      })
    }
  }

  await created.stopProxy()

  const ok = results.every(result => result.ok)
  const summary = {
    scenario: "web2_dahr_rejects",
    ok,
    cases: results,
    timestamp: new Date().toISOString(),
  }

  writeWeb2Summary("web2_dahr_rejects.summary.json", summary)
  console.log(JSON.stringify({ web2_dahr_rejects_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("web2_dahr_rejects failed: DAHR reject behavior did not match expectations")
  }
}

if (import.meta.main) {
  await runWeb2DahrRejects()
}
