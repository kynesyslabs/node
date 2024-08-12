import express, { Request, Response } from "express"

const serverApp = express()
const port = 53550

/* Interface definitions */

export interface RPCRequest {
    method: string
    params: any[]
}

export interface RPCResponse {
    result: number // HTTP status code
    response: any
    require_reply: boolean
    extra: any
}

/* End of interface definitions */

// Middleware to parse JSON payloads
serverApp.use(express.json())

// GET request handler
serverApp.get("/", (req: Request, res: Response) => {
    res.send("Hello, World!")
})


// Type guard to check if the payload is an RPCRequest
function isRPCRequest(obj: any): obj is RPCRequest {
    return (
      typeof obj === "object" &&
      obj !== null &&
      "method" in obj &&
      typeof obj.method === "string" &&
      "params" in obj &&
      Array.isArray(obj.params)
    )
  }

// POST request handler
serverApp.post("/", (req: Request, res: Response) => {
    if (!isRPCRequest(req.body)) {
        return res.status(400).json({ error: "Invalid RPCRequest format" })
      }
      const payload = req.body as RPCRequest
      const response = processPayload(payload)
      res.json(response) // Send the response back to the client
})


// Function to process the payload
async function processPayload(payload: RPCRequest): Promise<RPCResponse> {
    // TODO: Implement your payload processing logic here
    return {
        result: 200,
        response: "Payload received",
        require_reply: false,
        extra: null,
    }
}

// Start the server
serverApp.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`)
})
