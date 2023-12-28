import * as sqlite3 from "sqlite3"

export class ActivityPubStorage {
    db: sqlite3.Database

    constructor(dbPath) {
        this.db = new sqlite3.Database(dbPath, err => {
            if (err) {
                console.error(err.message)
            }
            console.log("Connected to the SQLite database.")
            this.createTables()
        })
    }

    createTables() {
        const collections = {
            actors: "id TEXT PRIMARY KEY, type TEXT, name TEXT, inbox TEXT, outbox TEXT, followers TEXT, following TEXT, liked TEXT",
            objects:
                "id TEXT PRIMARY KEY, type TEXT, attributedTo TEXT, content TEXT",
            activities:
                "id TEXT PRIMARY KEY, type TEXT, actor TEXT, object TEXT",
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

        for (const [collection, columns] of Object.entries(collections)) {
            const sql = `CREATE TABLE IF NOT EXISTS ${collection} (${columns})`
            this.db.run(sql)
        }
    }

    saveItem(collection, item) {
        const sql = `INSERT INTO ${collection}(id, data) VALUES(?, ?)`
        this.db.run(sql, [item.id, JSON.stringify(item)], function (err) {
            if (err) {
                return console.error(err.message)
            }
            console.log(`Item with ID ${item.id} inserted into ${collection}`)
        })
    }

    getItem(collection, id, callback) {
        const sql = `SELECT * FROM ${collection} WHERE id = ?`
        this.db.get(sql, [id], (err, row: any) => {
            if (err) {
                return console.error(err.message)
            }
            try {
                console.log(row)
                const data = row
                callback(data)
            } catch (e) {
                console.error("Error parsing JSON data:", e)
            }
        })
    }

    deleteItem(collection, id) {
        const sql = `DELETE FROM ${collection} WHERE id = ?`
        this.db.run(sql, [id], function (err) {
            if (err) {
                return console.error(err.message)
            }
            console.log(`Item with ID ${id} deleted from ${collection}`)
        })
    }
}
