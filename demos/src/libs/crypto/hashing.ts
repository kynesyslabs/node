import { sha256 } from "node-forge"

export default class Hashing {
    static sha256(message: string) {
        const md = sha256.create()
        md.update(message)
        return md.digest().toHex()
    }
}
