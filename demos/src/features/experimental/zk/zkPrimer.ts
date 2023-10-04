var bigInt = require("big-integer")

function millerRabinTest(n: any, k: number): boolean {
    if (n.leq(1) || n.equals(2)) return n.equals(2)
    if (n.isEven()) return false

    let r = 0
    let d = n.minus(1)

    while (d.isEven()) {
        r++
        d = d.divide(2)
    }

    for (let i = 0; i < k; i++) {
        const a = bigInt.randBetween(2, n.minus(2))
        let x = a.modPow(d, n)

        if (x.equals(1) || x.equals(n.minus(1))) continue

        let continueLoop = false
        for (let j = 0; j < r - 1; j++) {
            x = x.modPow(2, n)
            if (x.equals(n.minus(1))) {
                continueLoop = true
                break
            }
        }

        if (continueLoop) continue

        return false
    }

    return true
}

export default function generateLargePrime(bits: number, testRounds: number): any {
    if (bits < 2) throw new Error("Bit-length must be >= 2")

    let prime
    do {
        prime = bigInt.randBetween(bigInt(2).pow(bits - 1), bigInt(2).pow(bits).subtract(1))
    } while (!millerRabinTest(prime, testRounds))

    return prime
}

const lock1 = generateLargePrime(2048, 5)
const lock2 = generateLargePrime(2048, 5)

console.log("Lock1 (p):", lock1.toString())
console.log("Lock2 (q):", lock2.toString())
