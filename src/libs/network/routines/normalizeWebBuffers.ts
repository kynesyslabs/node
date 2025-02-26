export function normalizeWebBuffers(webBuffer: any): [Buffer, string] {
    try {
        // In case is a string we need to convert it to an object
        if (typeof webBuffer === "string") {
            webBuffer = JSON.parse(webBuffer)
        }
        // Then we can start the normalization process
        if (webBuffer.type === "Buffer") {
            return [Buffer.from(webBuffer), null]
        } else {
            // Parsing the Uint8Array and Buffering it
            const bufferized = {
                type: "Buffer",
                data: [],
            }
            for (let i = 0; i < webBuffer.length; i++) {
                if (webBuffer[i] > 255) {
                    throw new Error("Buffer contains non-ASCII characters")
                }
                if (webBuffer[i] < 0) {
                    throw new Error("Buffer contains negative values")
                }
                bufferized.data.push(webBuffer[i])
            }
            return [Buffer.from(bufferized.data), null]
        }
    } catch (e) {
        return [null, e["message"]]
    }
}
