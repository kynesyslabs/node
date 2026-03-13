/**
 * TLSNotary Routes for BunServer
 *
 * HTTP API endpoints for TLSNotary operations:
 * - GET /tlsnotary/health - Health check
 * - GET /tlsnotary/info - Service info with public key
 * - POST /tlsnotary/verify - Verify attestation
 *
 * @module features/tlsnotary/routes
 */

// REVIEW: TLSNotary routes - new API endpoints for HTTPS attestation
import { getTLSNotaryService } from "./TLSNotaryService"
import type { BunServer } from "@/libs/network/bunServer"
import { jsonResponse } from "@/libs/network/bunServer"
import log from "@/utilities/logger"
import type { VerifyRequestBody, HealthResponse, InfoResponse, VerifyResponse } from "./types"

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Health check handler
 */
async function healthHandler(): Promise<Response> {
  const service = getTLSNotaryService()

  if (!service) {
    const response: HealthResponse = {
      status: "disabled",
      service: "tlsnotary",
    }
    return jsonResponse(response)
  }

  const status = service.getStatus()

  if (!status.health.healthy) {
    const response: HealthResponse = {
      status: "unhealthy",
      service: "tlsnotary",
      initialized: status.health.initialized,
      serverRunning: status.health.serverRunning,
      error: status.health.error,
    }
    return jsonResponse(response, 503)
  }

  const response: HealthResponse = {
    status: "healthy",
    service: "tlsnotary",
    initialized: status.health.initialized,
    serverRunning: status.health.serverRunning,
  }
  return jsonResponse(response)
}

/**
 * Service info handler
 */
async function infoHandler(): Promise<Response> {
  const service = getTLSNotaryService()

  if (!service) {
    const response: InfoResponse = {
      enabled: false,
      port: 0,
    }
    return jsonResponse(response)
  }

  const status = service.getStatus()

  const response: InfoResponse = {
    enabled: status.enabled,
    port: status.port,
    publicKey: status.health.publicKey,
    running: status.running,
  }
  return jsonResponse(response)
}

/**
 * Verify attestation handler
 */
async function verifyHandler(req: Request): Promise<Response> {
  const service = getTLSNotaryService()

  if (!service) {
    const response: VerifyResponse = {
      success: false,
      error: "TLSNotary service is not enabled",
    }
    return jsonResponse(response, 503)
  }

  if (!service.isRunning()) {
    const response: VerifyResponse = {
      success: false,
      error: "TLSNotary service is not running",
    }
    return jsonResponse(response, 503)
  }

  let body: VerifyRequestBody
  try {
    body = await req.json()
  } catch {
    const response: VerifyResponse = {
      success: false,
      error: "Invalid JSON body",
    }
    return jsonResponse(response, 400)
  }

  const { attestation } = body

  if (!attestation || typeof attestation !== "string") {
    const response: VerifyResponse = {
      success: false,
      error: "Missing or invalid attestation parameter",
    }
    return jsonResponse(response, 400)
  }

  try {
    const result = service.verify(attestation)

    if (result.success) {
      const response: VerifyResponse = {
        success: true,
        serverName: result.serverName,
        connectionTime: result.connectionTime,
        sentLength: result.sentLength,
        recvLength: result.recvLength,
      }
      return jsonResponse(response)
    } else {
      const response: VerifyResponse = {
        success: false,
        error: result.error,
      }
      return jsonResponse(response, 400)
    }
  } catch (error) {
    const response: VerifyResponse = {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during verification",
    }
    return jsonResponse(response, 500)
  }
}

// ============================================================================
// Route Registration
// ============================================================================

/**
 * Register TLSNotary routes with BunServer
 *
 * Routes:
 * - GET /tlsnotary/health - Health check endpoint
 * - GET /tlsnotary/info - Service info with public key (for SDK discovery)
 * - POST /tlsnotary/verify - Verify an attestation
 *
 * @param server - BunServer instance
 */
export function registerTLSNotaryRoutes(server: BunServer): void {
  // Health check
  server.get("/tlsnotary/health", healthHandler)

  // Service info (for SDK discovery)
  server.get("/tlsnotary/info", infoHandler)

  // Verify attestation
  server.post("/tlsnotary/verify", verifyHandler)

  log.info("[TLSNotary] Routes registered: /tlsnotary/health, /tlsnotary/info, /tlsnotary/verify")
}

export default registerTLSNotaryRoutes
