# Storage Programs Examples

Real-world implementations and practical patterns for Storage Programs.

## Table of Contents

1. [User Management System](#user-management-system)
2. [Social Media Platform](#social-media-platform)
3. [Multi-Player Game](#multi-player-game)
4. [Document Collaboration](#document-collaboration)
5. [E-Commerce Store](#e-commerce-store)
6. [DAO Governance](#dao-governance)
7. [Content Management System](#content-management-system)
8. [Task Management App](#task-management-app)

## User Management System

Complete user profile and settings management.

### Implementation

```typescript
import { DemosClient } from '@kynesyslabs/demosdk'
import { deriveStorageAddress } from '@kynesyslabs/demosdk/storage'

class UserManager {
  private demos: DemosClient

  constructor(rpcUrl: string, privateKey: string) {
    this.demos = new DemosClient({ rpcUrl, privateKey })
  }

  async createUser(userData: {
    username: string
    email: string
    displayName: string
  }) {
    const userAddress = await this.demos.getAddress()

    // Create private user storage
    const result = await this.demos.storageProgram.create(
      `user-${userData.username}`,
      "private",
      {
        initialData: {
          profile: {
            username: userData.username,
            email: userData.email,
            displayName: userData.displayName,
            avatar: "",
            bio: ""
          },
          settings: {
            theme: "light",
            language: "en",
            notifications: {
              email: true,
              push: true
            },
            privacy: {
              showEmail: false,
              showActivity: true
            }
          },
          activity: {
            lastLogin: Date.now(),
            loginCount: 1,
            createdAt: Date.now()
          },
          metadata: {
            version: 1,
            storageAddress: "" // Will be filled in
          }
        }
      }
    )

    // Update with storage address
    await this.demos.storageProgram.write(result.storageAddress, {
      metadata: {
        version: 1,
        storageAddress: result.storageAddress
      }
    })

    return {
      success: true,
      userAddress: userAddress,
      storageAddress: result.storageAddress
    }
  }

  async updateProfile(storageAddress: string, updates: any) {
    const current = await this.demos.storageProgram.read(storageAddress)

    await this.demos.storageProgram.write(storageAddress, {
      profile: {
        ...current.data.variables.profile,
        ...updates
      },
      activity: {
        ...current.data.variables.activity,
        lastUpdated: Date.now()
      }
    })
  }

  async updateSettings(storageAddress: string, settings: any) {
    await this.demos.storageProgram.write(storageAddress, {
      settings: settings
    })
  }

  async recordLogin(storageAddress: string) {
    const current = await this.demos.storageProgram.read(storageAddress)
    const activity = current.data.variables.activity

    await this.demos.storageProgram.write(storageAddress, {
      activity: {
        ...activity,
        lastLogin: Date.now(),
        loginCount: activity.loginCount + 1
      }
    })
  }

  async getUser(storageAddress: string) {
    const result = await this.demos.storageProgram.read(storageAddress)
    return result.data.variables
  }

  async deleteUser(storageAddress: string) {
    await this.demos.storageProgram.delete(storageAddress)
  }
}

// Usage
const userManager = new UserManager(
  'https://rpc.demos.network',
  process.env.PRIVATE_KEY
)

const user = await userManager.createUser({
  username: "alice",
  email: "alice@example.com",
  displayName: "Alice"
})

await userManager.updateProfile(user.storageAddress, {
  bio: "Web3 developer",
  avatar: "ipfs://..."
})

await userManager.recordLogin(user.storageAddress)
```

## Social Media Platform

Public posts with private user data.

### Implementation

```typescript
class SocialPlatform {
  private demos: DemosClient

  constructor(rpcUrl: string, privateKey: string) {
    this.demos = new DemosClient({ rpcUrl, privateKey })
  }

  // Create public feed storage
  async createFeed() {
    return await this.demos.storageProgram.create(
      "globalFeed",
      "public",
      {
        initialData: {
          posts: [],
          stats: {
            totalPosts: 0,
            totalUsers: 0
          }
        }
      }
    )
  }

  // Create private user storage
  async createUserAccount(username: string) {
    const userAddress = await this.demos.getAddress()

    return await this.demos.storageProgram.create(
      `user-${username}`,
      "private",
      {
        initialData: {
          username: username,
          drafts: [],
          savedPosts: [],
          following: [],
          followers: [],
          privateNotes: {}
        }
      }
    )
  }

  // Post to public feed
  async createPost(feedAddress: string, post: {
    title: string
    content: string
    tags: string[]
  }) {
    const feed = await this.demos.storageProgram.read(feedAddress)
    const currentPosts = feed.data.variables.posts || []

    const newPost = {
      id: Date.now().toString(),
      author: await this.demos.getAddress(),
      title: post.title,
      content: post.content,
      tags: post.tags,
      timestamp: Date.now(),
      likes: 0,
      comments: []
    }

    await this.demos.storageProgram.write(feedAddress, {
      posts: [newPost, ...currentPosts].slice(0, 100), // Keep last 100 posts
      stats: {
        totalPosts: feed.data.variables.stats.totalPosts + 1,
        totalUsers: feed.data.variables.stats.totalUsers
      }
    })

    return newPost.id
  }

  // Like a post (update public feed)
  async likePost(feedAddress: string, postId: string) {
    const feed = await this.demos.storageProgram.read(feedAddress)
    const posts = feed.data.variables.posts

    const updatedPosts = posts.map(p =>
      p.id === postId ? { ...p, likes: p.likes + 1 } : p
    )

    await this.demos.storageProgram.write(feedAddress, {
      posts: updatedPosts
    })
  }

  // Save post to private storage
  async savePostPrivately(userStorage: string, postId: string) {
    const user = await this.demos.storageProgram.read(userStorage)
    const savedPosts = user.data.variables.savedPosts || []

    await this.demos.storageProgram.write(userStorage, {
      savedPosts: [...savedPosts, { postId, savedAt: Date.now() }]
    })
  }

  // Read public feed (anyone can read)
  async getFeed(feedAddress: string, limit: number = 20) {
    const feed = await this.demos.storageProgram.read(feedAddress)
    return feed.data.variables.posts.slice(0, limit)
  }
}

// Usage
const social = new SocialPlatform(
  'https://rpc.demos.network',
  process.env.PRIVATE_KEY
)

const feed = await social.createFeed()
const userAccount = await social.createUserAccount("alice")

const postId = await social.createPost(feed.storageAddress, {
  title: "Hello Demos Network!",
  content: "My first post on decentralized social media",
  tags: ["intro", "web3"]
})

await social.likePost(feed.storageAddress, postId)
await social.savePostPrivately(userAccount.storageAddress, postId)

// Anyone can read the public feed
const posts = await social.getFeed(feed.storageAddress)
console.log('Latest posts:', posts)
```

## Multi-Player Game

Game state management with restricted access.

### Implementation

```typescript
class GameLobby {
  private demos: DemosClient

  constructor(rpcUrl: string, privateKey: string) {
    this.demos = new DemosClient({ rpcUrl, privateKey })
  }

  async createLobby(lobbyName: string, players: string[]) {
    return await this.demos.storageProgram.create(
      `game-${lobbyName}`,
      "restricted",
      {
        allowedAddresses: players,
        initialData: {
          lobbyInfo: {
            name: lobbyName,
            host: await this.demos.getAddress(),
            maxPlayers: players.length,
            status: "waiting" // waiting, playing, finished
          },
          players: players.map(addr => ({
            address: addr,
            ready: false,
            score: 0,
            status: "connected"
          })),
          gameState: {
            currentRound: 0,
            startedAt: null,
            endedAt: null
          },
          chat: [],
          events: []
        }
      }
    )
  }

  async playerReady(lobbyAddress: string) {
    const playerAddress = await this.demos.getAddress()
    const lobby = await this.demos.storageProgram.read(lobbyAddress)

    const updatedPlayers = lobby.data.variables.players.map(p =>
      p.address === playerAddress ? { ...p, ready: true } : p
    )

    await this.demos.storageProgram.write(lobbyAddress, {
      players: updatedPlayers,
      events: [
        ...lobby.data.variables.events,
        {
          type: "player_ready",
          player: playerAddress,
          timestamp: Date.now()
        }
      ]
    })

    // Check if all players ready
    const allReady = updatedPlayers.every(p => p.ready)
    if (allReady) {
      await this.startGame(lobbyAddress)
    }
  }

  async startGame(lobbyAddress: string) {
    const lobby = await this.demos.storageProgram.read(lobbyAddress)

    await this.demos.storageProgram.write(lobbyAddress, {
      lobbyInfo: {
        ...lobby.data.variables.lobbyInfo,
        status: "playing"
      },
      gameState: {
        currentRound: 1,
        startedAt: Date.now(),
        endedAt: null
      },
      events: [
        ...lobby.data.variables.events,
        {
          type: "game_started",
          timestamp: Date.now()
        }
      ]
    })
  }

  async updateScore(lobbyAddress: string, playerAddress: string, points: number) {
    const lobby = await this.demos.storageProgram.read(lobbyAddress)

    const updatedPlayers = lobby.data.variables.players.map(p =>
      p.address === playerAddress
        ? { ...p, score: p.score + points }
        : p
    )

    await this.demos.storageProgram.write(lobbyAddress, {
      players: updatedPlayers,
      events: [
        ...lobby.data.variables.events,
        {
          type: "score_update",
          player: playerAddress,
          points: points,
          timestamp: Date.now()
        }
      ]
    })
  }

  async sendChatMessage(lobbyAddress: string, message: string) {
    const playerAddress = await this.demos.getAddress()
    const lobby = await this.demos.storageProgram.read(lobbyAddress)

    await this.demos.storageProgram.write(lobbyAddress, {
      chat: [
        ...lobby.data.variables.chat,
        {
          from: playerAddress,
          message: message,
          timestamp: Date.now()
        }
      ]
    })
  }

  async endGame(lobbyAddress: string) {
    const lobby = await this.demos.storageProgram.read(lobbyAddress)

    // Calculate winner
    const players = lobby.data.variables.players
    const winner = players.reduce((max, p) =>
      p.score > max.score ? p : max
    )

    await this.demos.storageProgram.write(lobbyAddress, {
      lobbyInfo: {
        ...lobby.data.variables.lobbyInfo,
        status: "finished"
      },
      gameState: {
        ...lobby.data.variables.gameState,
        endedAt: Date.now(),
        winner: winner.address
      },
      events: [
        ...lobby.data.variables.events,
        {
          type: "game_ended",
          winner: winner.address,
          finalScore: winner.score,
          timestamp: Date.now()
        }
      ]
    })
  }
}

// Usage
const game = new GameLobby(
  'https://rpc.demos.network',
  process.env.PRIVATE_KEY
)

const players = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222"
]

const lobby = await game.createLobby("epic-match-1", players)

// Players mark themselves ready
await game.playerReady(lobby.storageAddress)

// Update scores during game
await game.updateScore(lobby.storageAddress, players[0], 100)
await game.updateScore(lobby.storageAddress, players[1], 75)

// Send chat message
await game.sendChatMessage(lobby.storageAddress, "Good game!")

// End game
await game.endGame(lobby.storageAddress)
```

## Document Collaboration

Real-time collaborative document editing.

### Implementation

```typescript
class CollaborativeDocument {
  private demos: DemosClient

  constructor(rpcUrl: string, privateKey: string) {
    this.demos = new DemosClient({ rpcUrl, privateKey })
  }

  async createDocument(
    title: string,
    collaborators: string[]
  ) {
    return await this.demos.storageProgram.create(
      `doc-${Date.now()}`,
      "restricted",
      {
        allowedAddresses: collaborators,
        initialData: {
          metadata: {
            title: title,
            owner: await this.demos.getAddress(),
            collaborators: collaborators,
            createdAt: Date.now(),
            lastModified: Date.now()
          },
          content: {
            title: title,
            body: "",
            sections: []
          },
          revisions: [],
          comments: [],
          permissions: collaborators.reduce((acc, addr) => {
            acc[addr] = { canEdit: true, canComment: true }
            return acc
          }, {} as Record<string, any>)
        }
      }
    )
  }

  async updateContent(docAddress: string, updates: {
    title?: string
    body?: string
    sections?: any[]
  }) {
    const doc = await this.demos.storageProgram.read(docAddress)
    const editor = await this.demos.getAddress()

    // Create revision
    const revision = {
      id: Date.now().toString(),
      editor: editor,
      changes: updates,
      timestamp: Date.now()
    }

    await this.demos.storageProgram.write(docAddress, {
      content: {
        ...doc.data.variables.content,
        ...updates
      },
      metadata: {
        ...doc.data.variables.metadata,
        lastModified: Date.now(),
        lastModifiedBy: editor
      },
      revisions: [
        revision,
        ...doc.data.variables.revisions
      ].slice(0, 50) // Keep last 50 revisions
    })
  }

  async addComment(docAddress: string, comment: {
    text: string
    position?: number
    replyTo?: string
  }) {
    const doc = await this.demos.storageProgram.read(docAddress)
    const author = await this.demos.getAddress()

    const newComment = {
      id: Date.now().toString(),
      author: author,
      text: comment.text,
      position: comment.position,
      replyTo: comment.replyTo,
      timestamp: Date.now(),
      resolved: false
    }

    await this.demos.storageProgram.write(docAddress, {
      comments: [...doc.data.variables.comments, newComment]
    })
  }

  async resolveComment(docAddress: string, commentId: string) {
    const doc = await this.demos.storageProgram.read(docAddress)

    const updatedComments = doc.data.variables.comments.map(c =>
      c.id === commentId ? { ...c, resolved: true } : c
    )

    await this.demos.storageProgram.write(docAddress, {
      comments: updatedComments
    })
  }

  async addCollaborator(docAddress: string, newCollaborator: string) {
    const doc = await this.demos.storageProgram.read(docAddress)
    const currentAllowed = doc.data.metadata.allowedAddresses

    // Update access control
    await this.demos.storageProgram.updateAccessControl(docAddress, {
      allowedAddresses: [...currentAllowed, newCollaborator]
    })

    // Update document metadata
    await this.demos.storageProgram.write(docAddress, {
      metadata: {
        ...doc.data.variables.metadata,
        collaborators: [...doc.data.variables.metadata.collaborators, newCollaborator]
      },
      permissions: {
        ...doc.data.variables.permissions,
        [newCollaborator]: { canEdit: true, canComment: true }
      }
    })
  }

  async getDocument(docAddress: string) {
    const result = await this.demos.storageProgram.read(docAddress)
    return result.data.variables
  }

  async getRevisionHistory(docAddress: string, limit: number = 10) {
    const doc = await this.demos.storageProgram.read(docAddress)
    return doc.data.variables.revisions.slice(0, limit)
  }
}

// Usage
const docs = new CollaborativeDocument(
  'https://rpc.demos.network',
  process.env.PRIVATE_KEY
)

const collaborators = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222"
]

const doc = await docs.createDocument("Project Proposal", collaborators)

await docs.updateContent(doc.storageAddress, {
  title: "Q4 Project Proposal",
  body: "## Executive Summary\n\nOur proposal for Q4...",
  sections: [
    { heading: "Introduction", content: "..." },
    { heading: "Goals", content: "..." }
  ]
})

await docs.addComment(doc.storageAddress, {
  text: "Great start! Can we add more details to the budget section?",
  position: 150
})

await docs.addCollaborator(doc.storageAddress, "0x3333...")
```

## E-Commerce Store

Product catalog with inventory management.

### Implementation

```typescript
class ECommerceStore {
  private demos: DemosClient

  constructor(rpcUrl: string, privateKey: string) {
    this.demos = new DemosClient({ rpcUrl, privateKey })
  }

  // Public product catalog
  async createCatalog(storeName: string) {
    return await this.demos.storageProgram.create(
      `store-${storeName}`,
      "public",
      {
        initialData: {
          storeInfo: {
            name: storeName,
            owner: await this.demos.getAddress(),
            createdAt: Date.now()
          },
          products: [],
          categories: [],
          stats: {
            totalProducts: 0,
            totalSales: 0,
            revenue: 0
          }
        }
      }
    )
  }

  // Private inventory management
  async createInventory(storeName: string) {
    return await this.demos.storageProgram.create(
      `inventory-${storeName}`,
      "private",
      {
        initialData: {
          stock: {},
          suppliers: [],
          orders: [],
          costs: {}
        }
      }
    )
  }

  async addProduct(catalogAddress: string, inventoryAddress: string, product: {
    name: string
    description: string
    price: number
    category: string
    images: string[]
    initialStock: number
    cost: number
  }) {
    const catalog = await this.demos.storageProgram.read(catalogAddress)

    const newProduct = {
      id: Date.now().toString(),
      name: product.name,
      description: product.description,
      price: product.price,
      category: product.category,
      images: product.images,
      available: true,
      addedAt: Date.now()
    }

    // Update public catalog
    await this.demos.storageProgram.write(catalogAddress, {
      products: [...catalog.data.variables.products, newProduct],
      stats: {
        ...catalog.data.variables.stats,
        totalProducts: catalog.data.variables.stats.totalProducts + 1
      }
    })

    // Update private inventory
    const inventory = await this.demos.storageProgram.read(inventoryAddress)
    await this.demos.storageProgram.write(inventoryAddress, {
      stock: {
        ...inventory.data.variables.stock,
        [newProduct.id]: product.initialStock
      },
      costs: {
        ...inventory.data.variables.costs,
        [newProduct.id]: product.cost
      }
    })

    return newProduct.id
  }

  async updateStock(inventoryAddress: string, productId: string, quantity: number) {
    const inventory = await this.demos.storageProgram.read(inventoryAddress)

    await this.demos.storageProgram.write(inventoryAddress, {
      stock: {
        ...inventory.data.variables.stock,
        [productId]: (inventory.data.variables.stock[productId] || 0) + quantity
      }
    })
  }

  async recordSale(
    catalogAddress: string,
    inventoryAddress: string,
    sale: {
      productId: string
      quantity: number
      customerAddress: string
    }
  ) {
    const catalog = await this.demos.storageProgram.read(catalogAddress)
    const inventory = await this.demos.storageProgram.read(inventoryAddress)

    const product = catalog.data.variables.products.find(p => p.id === sale.productId)
    if (!product) throw new Error("Product not found")

    const currentStock = inventory.data.variables.stock[sale.productId] || 0
    if (currentStock < sale.quantity) throw new Error("Insufficient stock")

    // Update inventory (private)
    await this.demos.storageProgram.write(inventoryAddress, {
      stock: {
        ...inventory.data.variables.stock,
        [sale.productId]: currentStock - sale.quantity
      },
      orders: [
        ...inventory.data.variables.orders,
        {
          id: Date.now().toString(),
          productId: sale.productId,
          quantity: sale.quantity,
          customer: sale.customerAddress,
          revenue: product.price * sale.quantity,
          timestamp: Date.now()
        }
      ]
    })

    // Update catalog stats (public)
    await this.demos.storageProgram.write(catalogAddress, {
      stats: {
        totalProducts: catalog.data.variables.stats.totalProducts,
        totalSales: catalog.data.variables.stats.totalSales + sale.quantity,
        revenue: catalog.data.variables.stats.revenue + (product.price * sale.quantity)
      }
    })
  }

  async getProducts(catalogAddress: string) {
    const catalog = await this.demos.storageProgram.read(catalogAddress)
    return catalog.data.variables.products
  }

  async getInventoryReport(inventoryAddress: string) {
    const inventory = await this.demos.storageProgram.read(inventoryAddress)
    return {
      stock: inventory.data.variables.stock,
      recentOrders: inventory.data.variables.orders.slice(0, 20)
    }
  }
}

// Usage
const store = new ECommerceStore(
  'https://rpc.demos.network',
  process.env.PRIVATE_KEY
)

const catalog = await store.createCatalog("TechGadgets")
const inventory = await store.createInventory("TechGadgets")

const productId = await store.addProduct(
  catalog.storageAddress,
  inventory.storageAddress,
  {
    name: "Wireless Headphones",
    description: "Premium noise-canceling headphones",
    price: 199.99,
    category: "Audio",
    images: ["ipfs://..."],
    initialStock: 50,
    cost: 100
  }
)

await store.recordSale(
  catalog.storageAddress,
  inventory.storageAddress,
  {
    productId: productId,
    quantity: 2,
    customerAddress: "0x4444..."
  }
)

// Anyone can view products
const products = await store.getProducts(catalog.storageAddress)
console.log('Available products:', products)

// Only owner can view inventory
const report = await store.getInventoryReport(inventory.storageAddress)
console.log('Stock levels:', report.stock)
```

## Next Steps

- [API Reference](./api-reference.md) - Complete API documentation
- [Access Control](./access-control.md) - Master permission systems
- [RPC Queries](./rpc-queries.md) - Optimize data reading
- [Operations](./operations.md) - Learn all CRUD operations
