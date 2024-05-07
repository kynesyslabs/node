import fetch from "node-fetch"

export default async function getRemoteIP() {
    try {
        let res = await fetch("https://icanhazip.com")
        let text = await res.text()
        text = text.replace("\n", "")
        return text
    } catch (error) {
        return "127.0.0.1"
    }
}