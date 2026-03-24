import { envBool, envInt, nowMs } from "./common"

type ProgressValue = string | number | boolean | null | undefined

export function startProgressReporter(params: {
  label: string
  getSnapshot: () => Record<string, ProgressValue>
  intervalMs?: number
}) {
  const enabled = envBool("REPORT_PROGRESS", true)
  if (!enabled) return () => {}

  const intervalMs = Math.max(250, params.intervalMs ?? envInt("PROGRESS_INTERVAL_MS", 5000))
  const timer = setInterval(() => {
    const snapshot = params.getSnapshot()
    const startedAtMs = typeof snapshot.startedAtMs === "number" ? snapshot.startedAtMs : nowMs()
    const elapsedSec = Math.max(0, (nowMs() - startedAtMs) / 1000)
    const parts = [`${elapsedSec.toFixed(1)}s`]

    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "startedAtMs" || value === undefined) continue
      parts.push(`${key}=${value}`)
    }

    console.error(`[progress] ${params.label} | ${parts.join(" | ")}`)
  }, intervalMs)

  if (typeof (timer as any).unref === "function") {
    ;(timer as any).unref()
  }

  return () => clearInterval(timer)
}
