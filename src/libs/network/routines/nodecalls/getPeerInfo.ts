import sharedState from "src/utilities/sharedState"

export default async function getPeerInfo(): Promise<string> {
    return sharedState.getInstance().connectionString
}