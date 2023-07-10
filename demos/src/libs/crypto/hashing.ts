import forge, { pki } from "node-forge"

export default class Hashing {
    static sha256(message: string) {
        const md = forge.md.sha256.create()
        md.update(message)
        return md.digest().toHex()
    }
}
