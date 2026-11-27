// Largest key or signature accepted, in bytes.
export const MAX_WEB_BUFFER_BYTES = 65536

export function normalizeWebBuffers(webBuffer: any): [Buffer, string] {
    try {
        // In case is a string we need to convert it to an object
        if (typeof webBuffer === "string") {
            webBuffer = JSON.parse(webBuffer)
        }
        // Accepts {type: "Buffer", data: []} or a plain byte array.
        const bytes = webBuffer.type === "Buffer" ? webBuffer.data : webBuffer
        if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) {
            throw new Error("Buffer is not a byte array")
        }
        if (bytes.length > MAX_WEB_BUFFER_BYTES) {
            throw new Error("Buffer is too large")
        }
        for (const byte of bytes) {
            if (byte > 255) {
                throw new Error("Buffer contains non-ASCII characters")
            }
            if (byte < 0) {
                throw new Error("Buffer contains negative values")
            }
        }
        return [Buffer.from(bytes), null]
    } catch (e) {
        return [null, e instanceof Error ? e.message : String(e)]
    }
}
