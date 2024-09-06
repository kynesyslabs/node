import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import log from "src/utilities/logger"

// List of available methods
const availableMethods = [ // ! Edit this so that is correct and has subcommands too
    "ping",
    "execute",
    "hello_peer",
    "consensus",
    "proofOfConsensus",
    "mempool",
    "auth",
    "nodeCall",
    "login_request",
    "login_response",
    "consensus_routine",
]

// Function to register the GET endpoint
export function registerMethodListingEndpoint(server: FastifyInstance) {
    server.get("/methods", async (request: FastifyRequest, reply: FastifyReply) => {
        log.info("[RPC Server] Received request for method listing")
        reply.send({
            methods: availableMethods,
            count: availableMethods.length,
        })
    })

    log.info("[RPC Server] Registered method listing endpoint")
}