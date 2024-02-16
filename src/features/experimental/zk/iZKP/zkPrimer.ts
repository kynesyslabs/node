import bigInt, { BigInteger } from "big-integer"

function isSmallPrimeDivisorPresent(n: BigInteger): boolean {
    const smallPrimes = [
        2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67,
        71, 73, 79, 83, 89, 97,
    ]
    for (const prime of smallPrimes) {
        if (n.mod(prime).isZero()) {
            return true
        }
    }
    return false
}

function millerRabinTest(n: BigInteger, k: number): boolean {
    if (n.leq(1) || n.equals(2)) return n.equals(2)
    if (n.isEven()) return false

    // Optimization: Check for small prime divisors first
    if (isSmallPrimeDivisorPresent(n)) return false

    let r = 0
    let d = n.minus(1)
    const two = bigInt(2)

    // Precompute values
    const nMinusOne = n.minus(1)
    const nMinusTwo = n.minus(2)

    while (d.isEven()) {
        r++
        d = d.divide(two)
    }

    for (let i = 0; i < k; i++) {
        const a = bigInt.randBetween(two, nMinusTwo)
        let x = a.modPow(d, n)
        if (x.equals(1) || x.equals(nMinusOne)) continue

        let continueLoop = false
        for (let j = 0; j < r - 1; j++) {
            x = x.modPow(two, n)
            if (x.equals(nMinusOne)) {
                continueLoop = true
                break
            }
        }
        if (continueLoop) continue
        return false
    }
    return true
}

export default function generateLargePrime(
    bits: number,
    testRounds: number,
): BigInteger {
    if (bits < 2) throw new Error("Bit-length must be >= 2")

    // Precompute powers of two
    const twoPowBitsMinusOne = bigInt(2).pow(bits - 1)
    const twoPowBits = bigInt(2).pow(bits)

    let prime: BigInteger
    do {
        prime = bigInt.randBetween(twoPowBitsMinusOne, twoPowBits.subtract(1))
    } while (!millerRabinTest(prime, testRounds))

    return prime
}
