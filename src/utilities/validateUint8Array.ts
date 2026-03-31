export default function validateIfUint8Array(
    input: unknown,
): Uint8Array | unknown {
    // Early exit for arrays and typed arrays - pass through unchanged
    if (Array.isArray(input) || ArrayBuffer.isView(input)) {
        return input
    }

    // Handle hex strings
    if (typeof input === "string" && input.startsWith("0x")) {
        const hexString = input.slice(2) // Remove "0x" prefix
        // Validate hex string before conversion
        if (hexString.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hexString)) {
            return Buffer.from(hexString, "hex")
        }

        return input
    }

    // Type guard: check if input is a record-like object with numeric integer keys and number values
    if (typeof input === "object" && input !== null) {
        // Skip conversion for transaction objects that are not meant to be Uint8Arrays
        const isSerializedTx = 'signature' in input && 'txID' in input && 'raw_data' in input
        if (isSerializedTx) {
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
        const allValuesNumbers = entries.every(
            ([, val]) => typeof val === "number",
        )

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
