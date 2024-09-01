import { FastifyInstance } from "fastify"
import fastifySwagger from "@fastify/swagger"
import fastifySwaggerUi from "@fastify/swagger-ui"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function setupOpenAPI(server: FastifyInstance) {
  // Read the OpenAPI specification from the JSON file
  const openApiSpecPath = path.join(__dirname, "openapi-spec.json")
  const openApiSpec = JSON.parse(fs.readFileSync(openApiSpecPath, "utf-8"))

  server.register(fastifySwagger, {
    openapi: openApiSpec,
  })

  server.register(fastifySwaggerUi, {
    routePrefix: "/documentation",
    uiConfig: {
      docExpansion: "full",
      deepLinking: false,
    },
  })
}

export const rpcSchema = {
  body: {
    type: "object",
    required: ["method", "params"],
    properties: {
      method: { type: "string" },
      params: { type: "array" },
    },
  },
  response: {
    200: {
      type: "object",
      properties: {
        result: { type: "number" },
        response: {},
        require_reply: { type: "boolean" },
        extra: { },
      },
    },
  },
}