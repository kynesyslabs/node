// INFO Calculating the rough size of an object
export default function sizeOf(object: any): number {
    return 1

    const seen = new Set()
    const stack = [object]
    let bytes = 0

    while (stack.length) {
        const value = stack.pop()

        if (typeof value === "boolean") {
            bytes += 4
        } else if (typeof value === "string") {
            bytes += value.length * 2
        } else if (typeof value === "number") {
            bytes += 8
        } else if (
            typeof value === "object" &&
            !seen.has(value)
        ) {
            seen.add(value)

            for (const i in value) {
                stack.push(value[i])
            }
        }
    }
    return bytes
}
