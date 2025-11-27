export default function validateIfUint8Array(input: unknown): Uint8Array | unknown {
    // Early exit for arrays and typed arrays - pass through unchanged
    if (Array.isArray(input) || ArrayBuffer.isView(input)) {
        return input
    }

    // Type guard: check if input is a record-like object with numeric integer keys and number values
    if (typeof input === "object" && input !== null) {
        // Skip conversion for transaction objects that have a signature property
        // (e.g., TRON transactions which are objects, not Uint8Arrays)
        if ('signature' in input || 'txID' in input || 'raw_data' in input) {
            return input
        }

        // Safely cast to indexable type after basic validation
        const record = input as Record<string, unknown>
        const entries = Object.entries(record)

        // Validate all keys are numeric integer strings
        const allKeysNumericIntegers = entries.every(([key]) => {
            const num = Number(key)
            return Number.isFinite(num) && Number.isInteger(num)
        })

        // Validate all values are numbers
        const allValuesNumbers = entries.every(([, val]) => typeof val === "number")

        if (allKeysNumericIntegers && allValuesNumbers) {
            // Sort by numeric key and extract values
            const sortedValues = entries
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([, val]) => val as number)
            return Buffer.from(sortedValues)
        }
    }
    return input
}
