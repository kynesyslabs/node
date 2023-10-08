/* eslint-disable no-undef */
// SECTION GUI
const startServer = document.getElementById("startServer")
const stopServer = document.getElementById("stopServer")
// !SECTION GUI

async function main() {
    console.log("[MANAGEMENT APP] Starting management app")
    setListeners()
    let running = true
    while (running) {
        await sleep(1000)
    }
}

async function setListeners() {
    startServer.addEventListener("click", () => {
        console.log("[MANAGEMENT APP] Starting server")
    })

    stopServer.addEventListener("click", () => {
        console.log("[MANAGEMENT APP] Stopping server")
    })

}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

main()