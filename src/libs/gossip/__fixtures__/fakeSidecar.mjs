// Stand-in for the gossip sidecar in lifecycle tests. Behaviour is read
// from FAKE_SIDECAR_MODE_FILE at startup so a test can change what the
// next launch does: "ok" serves the IPC protocol, "hang" never opens the
// socket, "crash" exits at once.
import fs from "node:fs"
import net from "node:net"
import readline from "node:readline"

const mode = fs.readFileSync(process.env.FAKE_SIDECAR_MODE_FILE, "utf8").trim()
fs.appendFileSync(process.env.FAKE_SIDECAR_LOG, `${process.pid} ${mode} ${Date.now()}\n`)

process.stdin.resume()
process.stdin.on("end", () => process.exit(0))

if (mode === "crash") process.exit(3)

if (mode === "ok") {
    const ipc = process.env.GOSSIP_IPC_PATH
    try {
        fs.unlinkSync(ipc)
    } catch {
        /* no stale socket */
    }
    const stats = () => ({
        type: "stats",
        v: 1,
        connections: 1,
        perTopic: { "demos/heights/1": { subscribers: 1, mesh: 1 } },
        lastInboundAt: Date.now(),
    })
    net.createServer(sock => {
        const send = o => sock.write(JSON.stringify(o) + "\n")
        readline.createInterface({ input: sock }).on("line", line => {
            if (JSON.parse(line).type !== "hello") return
            send({ type: "hello", v: 1 })
            send({ type: "ready", v: 1, peerId: `fake-${process.pid}`, addrs: [] })
            send(stats())
        })
        const t = setInterval(() => send(stats()), 50)
        sock.on("close", () => clearInterval(t))
        sock.on("error", () => sock.destroy())
    }).listen(ipc)
}
