export function compare(a: number, b: number): number {
    return a > b ? 1 : a < b ? -1 : 0
}

export function add(a: number, b: number): number {
    return a + b
}

export function sum(arr: number[]): number {
    return arr.reduce(add)
}

export function mean(arr: number[]): number {
    return sum(arr) / arr.length
}

export function std(arr: number[]): number {
    return Math.sqrt(variance(arr))
}

export function variance(arr: number[]): number {
    if (arr.length < 2) return 0

    const _mean = mean(arr)
    return arr.map(x => Math.pow(x - _mean, 2)).reduce(add) / (arr.length - 1)
}

export function calculateIQR(data) {
    const sortedData = [...data].sort((a, b) => a - b)
    const q1 = sortedData[Math.floor(sortedData.length / 4)]
    const q3 = sortedData[Math.ceil(sortedData.length * (3 / 4))]
    const iqr = q3 - q1
    return { iqr, q1, q3 }
}

export function filterOutliers(data) {
    const { iqr, q1, q3 } = calculateIQR(data)
    return data.filter(x => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr)
}

export function median(arr: number[]): number {
    if (arr.length < 2) return arr[0]

    const sorted = arr.slice().sort(compare)
    if (sorted.length % 2 === 0) {
        // even
        return (sorted[arr.length / 2 - 1] + sorted[arr.length / 2]) / 2
    } else {
        // odd
        return sorted[(arr.length - 1) / 2]
    }
}
