import * as fs from "fs"
import { Config } from "src/config"

// NOTE This method is mainly used by index.ts when we generate a new identity and we have no valid peers
// (aka talking to ourselves)
export default async function selfPeer() {
    const publicKeyFile = "publickey"
    const publicKey = fs.readFileSync(publicKeyFile, "utf8")
    const basicPeerScript = `
    {
        "${publicKey}": "${Config.getInstance().core.exposedUrl}"
    }
    `
    const basicPeerScriptFile = "demos_peerlist.json"
    fs.rmSync(basicPeerScriptFile)
    await fs.promises.writeFile(basicPeerScriptFile, basicPeerScript)
}
