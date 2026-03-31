import * as sqlite3 from "sqlite3"
import log from "@/utilities/logger"

export class ActivityPubStorage {
    db: sqlite3.Database
    private readonly validCollections: Set<string>
    private readonly collectionSchemas = {
        actors: "id TEXT PRIMARY KEY, type TEXT, name TEXT, inbox TEXT, outbox TEXT, followers TEXT, following TEXT, liked TEXT",
        objects:
            "id TEXT PRIMARY KEY, type TEXT, attributedTo TEXT, content TEXT",
        activities: "id TEXT PRIMARY KEY, type TEXT, actor TEXT, object TEXT",
        inboxes: "id TEXT PRIMARY KEY, owner TEXT, content TEXT",
        outboxes: "id TEXT PRIMARY KEY, owner TEXT, content TEXT",
        followers: "id TEXT PRIMARY KEY, owner TEXT, actor TEXT",
        followings: "id TEXT PRIMARY KEY, owner TEXT, actor TEXT",
        likeds: "id TEXT PRIMARY KEY, owner TEXT, object TEXT",
        collections: "id TEXT PRIMARY KEY, owner TEXT, items TEXT",
        blockeds: "id TEXT PRIMARY KEY, owner TEXT, actor TEXT",
        rejections: "id TEXT PRIMARY KEY, owner TEXT, activity TEXT",
        rejecteds: "id TEXT PRIMARY KEY, owner TEXT, activity TEXT",
        shares: "id TEXT PRIMARY KEY, owner TEXT, object TEXT",
        likes: "id TEXT PRIMARY KEY, owner TEXT, object TEXT",
    }

    constructor(dbPath) {
        this.db = new sqlite3.Database(dbPath, err => {
            if (err) {
                log.error(err.message)
            }
            log.info("Connected to the SQLite database.")
            this.createTables()
        })

        // Initialize valid collections whitelist from the single source of truth
        this.validCollections = new Set(Object.keys(this.collectionSchemas))
    }

    private validateCollection(collection: string): void {
        if (!this.validCollections.has(collection)) {
            throw new Error(`Invalid collection name: ${collection}`)
        }
    }

    createTables() {
        for (const [collection, columns] of Object.entries(
            this.collectionSchemas,
        )) {
            const sql = `CREATE TABLE IF NOT EXISTS ${collection} (${columns})`
            this.db.run(sql)
        }
    }

    saveItem(collection, item) {
        this.validateCollection(collection)
        const sql = `INSERT INTO ${collection}(id, data) VALUES(?, ?)`
        this.db.run(sql, [item.id, JSON.stringify(item)], function (err) {
            if (err) {
                return log.error(err.message)
            }
            log.debug(`Item with ID ${item.id} inserted into ${collection}`)
        })
    }

    getItem(collection, id, callback) {
        this.validateCollection(collection)
        const sql = `SELECT * FROM ${collection} WHERE id = ?`
        this.db.get(sql, [id], (err, row: any) => {
            if (err) {
                return log.error(err.message)
            }
            try {
                log.debug(row)
                const data = row
                callback(data)
            } catch (e) {
                log.error("Error parsing JSON data:", e)
            }
        })
    }

    deleteItem(collection, id) {
        this.validateCollection(collection)
        const sql = `DELETE FROM ${collection} WHERE id = ?`
        this.db.run(sql, [id], function (err) {
            if (err) {
                return log.error(err.message)
            }
            log.debug(`Item with ID ${id} deleted from ${collection}`)
        })
    }
}
