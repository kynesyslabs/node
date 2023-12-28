

// Define the interfaces
export interface ActivityPubObject {
    "@context": string;
    type: string;
    id: string;
    actor?: string;
    object?: string;
  }
  
  export interface Actor extends ActivityPubObject {
    name: string;
    inbox: string;
    outbox: string;
    followers: string;
    following: string;
    liked: string;
  }
  
  export interface Collection {
    "@context": string;
    id: string;
    type: string;
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
  export var activityPubObject = initializeActivityPubObject("")
  export var actor: Actor = {
    ...initializeActivityPubObject("Person"),
    name: "",
    inbox: "",
    outbox: "",
    followers: "",
    following: "",
    liked: "",
  }
  export var collection = initializeCollection()
  export var inbox = initializeCollection()
  export var outbox = initializeCollection()
  export var followers = initializeCollection()
  export var following = initializeCollection()
  export var liked = initializeCollection()
  export var blocked = initializeCollection()
  export var rejections = initializeCollection()
  export var rejected = initializeCollection()
  export var shares = initializeCollection()
  export var likes = initializeCollection()
