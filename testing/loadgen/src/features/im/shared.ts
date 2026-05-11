import {
  decodePerfPayload,
  encodePerfPayload,
  generateClientId,
  getImTargets,
  maybeSilenceConsole,
  registerClient,
} from "../../im_shared"
import { envInt, nowMs } from "../../framework/common"

export { maybeSilenceConsole, generateClientId, encodePerfPayload, decodePerfPayload, registerClient, nowMs }

export function getImFeatureTargets(): string[] {
  return getImTargets()
}

export async function waitForJsonMessage(
  ws: WebSocket,
  predicate: (message: any) => boolean,
  timeoutMs = envInt("IM_MESSAGE_TIMEOUT_MS", 10000),
): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for IM message after ${timeoutMs}ms`))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage as EventListener)
      ws.removeEventListener("error", onError as EventListener)
    }

    const onError = (event: Event) => {
      cleanup()
      reject(new Error(`WebSocket error while waiting for IM message: ${event.type}`))
    }

    const onMessage = (evt: MessageEvent) => {
      try {
        const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as any)
        const parsed = JSON.parse(raw)
        if (!predicate(parsed)) return
        cleanup()
        resolve(parsed)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }

    ws.addEventListener("message", onMessage as EventListener)
    ws.addEventListener("error", onError as EventListener)
  })
}
