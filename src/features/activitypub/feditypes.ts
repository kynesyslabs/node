// Define the interfaces
export interface ActivityPubObject {
    "@context": string
    type: string
    id: string
    actor?: string
    object?: string
}

export interface Actor extends ActivityPubObject {
    name: string
    inbox: string
    outbox: string
    followers: string
    following: string
    liked: string
}

export interface Collection {
    "@context": string
    id: string
    type: string
}

// Function to initialize ActivityPub objects
export function initializeActivityPubObject(type: string): ActivityPubObject {
    return {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: type,
        id: "",
    }
}

// Function to initialize collections
export function initializeCollection(): Collection {
    return {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "",
        type: "OrderedCollection",
    }
}

// Initialize the objects
export const activityPubObject = initializeActivityPubObject("")
export const actor: Actor = {
    ...initializeActivityPubObject("Person"),
    name: "",
    inbox: "",
    outbox: "",
    followers: "",
    following: "",
    liked: "",
}
export const collection = initializeCollection()
export const inbox = initializeCollection()
export const outbox = initializeCollection()
export const followers = initializeCollection()
export const following = initializeCollection()
export const liked = initializeCollection()
export const blocked = initializeCollection()
export const rejections = initializeCollection()
export const rejected = initializeCollection()
export const shares = initializeCollection()
export const likes = initializeCollection()
