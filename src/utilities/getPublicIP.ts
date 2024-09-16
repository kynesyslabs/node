import axios from "axios"

export default async function getPublicIP() {
    const response = await axios.get("https://api.ipify.org?format=json")
    return response.data.ip
}