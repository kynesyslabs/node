import * as fs from "fs"

// NOTE This method is mainly used by index.ts when we generate a new identity and we have no valid peers
// (aka talking to ourselves)
export default async function selfPeer() {
    let public_key_file = "publickey"
    let public_key = fs.readFileSync(public_key_file, "utf8")
    let basic_peer_script = `
    {
        "${public_key}": "${process.env.EXPOSED_URL}"
    }
    `
    let basic_peer_script_file = "demos_peerlist.json"
    fs.rmSync(basic_peer_script_file)
    fs.writeFileSync(basic_peer_script_file, basic_peer_script)
}
