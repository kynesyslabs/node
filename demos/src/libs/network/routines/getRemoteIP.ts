import fetch from "node-fetch"

export default async function getRemoteIP() {
    let res = await fetch("https://icanhazip.com")
    let text = await res.text()
    text = text.replace("\n", "")
    return text
}

getRemoteIP()