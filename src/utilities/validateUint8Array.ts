export default function validateIfUint8Array(input: unknown): Uint8Array | unknown {
    // Type guard: check if input is a record-like object with numeric keys and values
    if (typeof input === "object" && input !== null) {
        // Safely cast to indexable type after basic validation
        const record = input as Record<string, unknown>

        // Validate all values are numbers before conversion
        const values = Object.values(record)
        if (values.every((val) => typeof val === "number")) {
            const txArray = Object.keys(record)
                .sort((a, b) => Number(a) - Number(b))
                .map((k) => record[k] as number)
            return Buffer.from(txArray)
        }
    }
    return input
}
