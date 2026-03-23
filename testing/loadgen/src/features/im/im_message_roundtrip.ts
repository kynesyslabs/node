import { getRunConfig, writeJson } from "../../framework/io"
import { envInt } from "../../framework/common"
import {
  decodePerfPayload,
  encodePerfPayload,
  generateClientId,
  getImFeatureTargets,
  maybeSilenceConsole,
  nowMs,
  registerClient,
  waitForJsonMessage,
} from "./shared"

export async function runImMessageRoundtrip() {
  maybeSilenceConsole()

  const wsUrl = getImFeatureTargets()[0]
  if (!wsUrl) throw new Error("im_message_roundtrip requires at least one signaling target")

  const timeoutMs = envInt("IM_MESSAGE_TIMEOUT_MS", 10000)
  const senderId = generateClientId()
  const receiverId = generateClientId()
  const messageId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  const run = getRunConfig()

  let sender: Awaited<ReturnType<typeof registerClient>> | null = null
  let receiver: Awaited<ReturnType<typeof registerClient>> | null = null
  let receiverMessage: any = null
  let senderMessage: any = null
  let latencyMs: number | null = null
  let scenarioError: string | null = null

  try {
    sender = await registerClient({
      wsUrl,
      clientId: senderId,
      instanceId: `im-roundtrip:${senderId}`,
      timeoutSec: Math.ceil(timeoutMs / 1000),
    })
    receiver = await registerClient({
      wsUrl,
      clientId: receiverId,
      instanceId: `im-roundtrip:${receiverId}`,
      timeoutSec: Math.ceil(timeoutMs / 1000),
    })

    const receiverInbound = waitForJsonMessage(
      receiver.ws,
      message => {
        if (message?.type !== "message") return false
        return message?.payload?.fromId === senderId
      },
      timeoutMs,
    )

    const senderInbound = waitForJsonMessage(
      sender.ws,
      message => {
        if (message?.type === "error") return true
        if (message?.type !== "message") return false
        return message?.payload?.fromId === receiverId
      },
      timeoutMs,
    )

    receiver.ws.addEventListener("message", async (evt: MessageEvent) => {
      const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as any)
      const message = JSON.parse(raw)
      if (message?.type !== "message" || message?.payload?.fromId !== senderId) return
      const payload = decodePerfPayload(message?.payload?.message)
      if (!payload || payload.id !== messageId || payload.role !== "ping") return
      receiver?.sendRaw({
        type: "message",
        payload: {
          targetId: senderId,
          message: encodePerfPayload({
            kind: "im_perf",
            role: "pong",
            id: payload.id,
            sentAtMs: payload.sentAtMs,
            sizeBytes: payload.sizeBytes,
          }),
        },
      })
    })

    const sentAtMs = nowMs()
    sender.sendRaw({
      type: "message",
      payload: {
        targetId: receiverId,
        message: encodePerfPayload({
          kind: "im_perf",
          role: "ping",
          id: messageId,
          sentAtMs,
          sizeBytes: 32,
        }),
      },
    })

    ;[receiverMessage, senderMessage] = await Promise.all([receiverInbound, senderInbound])
    const receiverPayload = decodePerfPayload(receiverMessage?.payload?.message)
    const senderPayload = decodePerfPayload(senderMessage?.payload?.message)
    latencyMs = nowMs() - sentAtMs

    const ok = Boolean(
      receiverPayload
      && senderPayload
      && senderMessage?.type === "message"
      && receiverPayload.id === messageId
      && receiverPayload.role === "ping"
      && senderPayload.id === messageId
      && senderPayload.role === "pong",
    )

    const summary = {
      scenario: "im_message_roundtrip",
      ok,
      wsUrl,
      senderId,
      receiverId,
      messageId,
      latencyMs,
      receiverMessage,
      senderMessage,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/im/im_message_roundtrip.summary.json`, summary)
    console.log(JSON.stringify({ im_message_roundtrip_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("im_message_roundtrip failed: sender/receiver did not exchange the expected ping/pong payloads")
    }
  } catch (error) {
    scenarioError = error instanceof Error ? error.message : String(error)
    const summary = {
      scenario: "im_message_roundtrip",
      ok: false,
      wsUrl,
      senderId,
      receiverId,
      messageId,
      latencyMs,
      receiverMessage,
      senderMessage,
      error: scenarioError,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/im/im_message_roundtrip.summary.json`, summary)
    console.log(JSON.stringify({ im_message_roundtrip_summary: summary }, null, 2))
    throw error
  } finally {
    sender?.close()
    receiver?.close()
  }
}

if (import.meta.main) {
  await runImMessageRoundtrip()
}
