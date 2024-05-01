import * as fs from "fs"

// NOTE This method is mainly used by index.ts when we generate a new identity and we have no valid peers
// (aka talking to ourselves)
export default async function selfPeer() {
    let public_key_file = "publickey"
    let public_key = fs.readFileSync(public_key_file, "utf8")
    let basic_peer_script = `
    [
        "http://127.0.0.1>53550>` + public_key + `"
    ]
    `
    let basic_peer_script_file = "demos_peers"
    fs.rmSync(basic_peer_script_file)
    fs.writeFileSync(basic_peer_script_file, basic_peer_script)
}
