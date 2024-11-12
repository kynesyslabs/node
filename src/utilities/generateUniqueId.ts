import Hashing from "src/libs/crypto/hashing"

export function generateUniqueId(): string {
    const timestamp = Date.now().toString()
    const random = Math.random().toString()
    const data = timestamp + random

    return Hashing.sha256(data)
}
