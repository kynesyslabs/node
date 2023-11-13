import { randomBytes } from "crypto"

class ItalianDevHash {
    // Class properties with type annotations
    P: number
    hashSize: number = 32
    saltSize: number
    modulo: bigint = BigInt(
        "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    )
    iterations: number
    seed: string | null

    constructor(
        prime: number = 31,
        saltSize: number = 16,
        iterations: number = 1,
        seed: string | null = null,
    ) {
        this.P = prime
        this.saltSize = saltSize
        this.iterations = iterations
        this.seed = seed
    }

    generateSalt(): Buffer {
        return randomBytes(this.saltSize)
    }
	generatePadding(input: string): string {
		let padding = ""
		let inputHash = this.simpleHash(input)
	
		for (let i = 0; i < this.hashSize - this.saltSize; i++) {
			let paddingChar = (inputHash + i) % 256
			padding += String.fromCharCode(paddingChar)
		}
	
		return padding
	}
	
	private simpleHash(input: string): number {
		let hash = 0
		for (const char of input) {
			hash = (hash + char.charCodeAt(0)) % 256
		}
		return hash
	}
	
    interleaveWithSalt(inputBuffer: Buffer, saltBuffer: Buffer): Buffer {
        let interleavedBuffer = Buffer.alloc(
            inputBuffer.length + saltBuffer.length,
        )
        let inputIndex = 0,
            saltIndex = 0

        for (let i = 0; i < interleavedBuffer.length; i++) {
            if (i % 2 === 0 && inputIndex < inputBuffer.length) {
                interleavedBuffer[i] = inputBuffer[inputIndex++]
            } else if (saltIndex < saltBuffer.length) {
                interleavedBuffer[i] = saltBuffer[saltIndex++]
            }
        }
        return interleavedBuffer
    }
    mixSeed(combinedBuffer: Buffer): Buffer {
        if (this.seed === null) {
            return combinedBuffer
        }

        const seedBuffer = Buffer.from(this.seed)
        let extendedSeedBuffer = seedBuffer
        while (extendedSeedBuffer.length < combinedBuffer.length) {
            extendedSeedBuffer = Buffer.concat([extendedSeedBuffer, seedBuffer])
        }

        for (let i = 0; i < combinedBuffer.length; i++) {
            // Enhanced mixing: Combine XOR with bitwise rotations
            let mix = combinedBuffer[i] ^ extendedSeedBuffer[i]
            mix = (mix << i % 8) | (mix >>> (8 - (i % 8))) // Bitwise rotation
            combinedBuffer[i] = mix
        }

        return combinedBuffer
    }

    hash(input: string, providedSalt?: string): { hash: string; salt: string } {
        // Validate and sanitize input
        if (typeof input !== "string") {
            throw new Error("Invalid input type")
        }

        let inputBuffer = Buffer.from(input)
        let salt: Buffer

        // Validate and use provided salt, if available
        if (providedSalt !== undefined) {
            if (typeof providedSalt !== "string") {
                throw new Error(
                    "Invalid salt format: Salt must be a UTF-8 string",
                )
            }
            salt = Buffer.from(providedSalt, "utf8")
        } else {
            salt = this.generateSalt()
        }

        inputBuffer = this.interleaveWithSalt(inputBuffer, salt)

        if (this.seed !== null) {
            inputBuffer = this.mixSeed(inputBuffer)
        }

        let hashValue = BigInt(0)
        for (let iter = 0; iter < this.iterations; iter++) {
            inputBuffer.forEach((byte, index) => {
                hashValue =
                    ((hashValue << BigInt(5)) +
                        hashValue +
                        BigInt(byte) +
                        BigInt(index)) %
                    this.modulo
            })

            if (iter < this.iterations - 1) {
                inputBuffer = Buffer.from(hashValue.toString(16), "hex")
            }
        }

        let finalHash = hashValue ^ BigInt("0x123456789ABCDEF123456789ABCDEF12")
        let hashHexString = finalHash
            .toString(16)
            .padStart(this.hashSize * 2, "0")
            .substring(0, this.hashSize * 2)

        return { hash: hashHexString, salt: salt.toString("hex") }
    }
}

// Example usage
const hasher = new ItalianDevHash(37, 20, 5, "aaaaaaaab") //, "optional_seed")
const result = hasher.hash("Hello, world!", "bsb") //, "optional_salt")
console.log("Salt:", result.salt)
console.log("Hash:", result.hash)


// BitBrew, EchoRoot
// RippleBranch
// Cascade