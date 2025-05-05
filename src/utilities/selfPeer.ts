import * as fs from "fs"

// NOTE This method is mainly used by index.ts when we generate a new identity and we have no valid peers
// (aka talking to ourselves)
export default async function selfPeer() {
    const publicKeyFile = "publickey"
    const publicKey = fs.readFileSync(publicKeyFile, "utf8")
    const basicPeerScript = `
    {
        "${publicKey}": "${process.env.EXPOSED_URL}"
    }
    `
    const basicPeerScriptFile = "demos_peerlist.json"
    fs.rmSync(basicPeerScriptFile)
    fs.writeFileSync(basicPeerScriptFile, basicPeerScript)
}
