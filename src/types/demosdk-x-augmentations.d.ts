import type {
    TwitterFollower,
    TwitterFollowersResponse,
    TwitterProfile,
    TwitterTimelineResponse,
    TwitterUser,
} from "@kynesyslabs/demosdk/build/types/web2/twitter"
import type { TwitterIdentity } from "@kynesyslabs/demosdk/build/types/gls/account"

declare module "@kynesyslabs/demosdk/types" {
    export type XIdentity = TwitterIdentity
    export type XUser = TwitterUser
    export type XProfile = TwitterProfile
    export type XTimelineResponse = TwitterTimelineResponse
    export type XFollower = TwitterFollower
    export type XFollowersResponse = TwitterFollowersResponse
}
