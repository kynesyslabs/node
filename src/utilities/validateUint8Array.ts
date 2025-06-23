export default function validateIfUint8Array(input: unknown): Uint8Array | unknown {
    if (typeof input === 'object' && input !== null) {
        const txArray = Object.keys(input)
            .sort((a, b) => Number(a) - Number(b))
            .map(k => input[k])
        return Buffer.from(txArray)
    }
    return input;
}
