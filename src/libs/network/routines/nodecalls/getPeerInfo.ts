import sharedState, { getSharedState} from "src/utilities/sharedState"

export default async function getPeerInfo(): Promise<string> {
    return getSharedState.connectionString
}