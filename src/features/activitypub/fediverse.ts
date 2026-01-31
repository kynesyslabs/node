import express from "express"
import helmet from "helmet"

import { ActivityPubStorage } from "./fedistore"
import log from "@/utilities/logger"

const app = express()
app.use(helmet())

let connected = false
let database: ActivityPubStorage

// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dotenv").config()

// Middleware to parse JSON bodies
app.use(express.json())

// REVIEW Experimental universal handlers

app.get(
    "/:collection/:id",
    (req: { params: { collection: any; id: any } }, res: any) => {
        const { collection, id } = req.params
        log.debug("Reading: " + collection + "/" + id)
        if (!database) {
            log.error("Database not initialized")
            res.status(500).json({ error: "Database not initialized" })
            return
        }
        // TODO Authentication
        database.getItem(collection, id, (item: any) => {
            if (item) {
                res.json(item)
            } else {
                res.status(404).send("Not found: " + collection + "/" + id)
            }
        })
    },
)

app.put(
    "/:collection/:id",
    (req: { params: { collection: any; id: any }; body: any }, res: any) => {
        const { collection, id } = req.params
        log.debug("Updating: " + collection + "/" + id)
        if (!database) {
            log.error("Database not initialized")
            res.status(500).json({ error: "Database not initialized" })
            return
        }
        // TODO Authentication
        database.saveItem(collection, req.body)
        res.json(req.body)
    },
)

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// NOTE INFO ANCHOR Starting our main function without blocking
async function main() {
    let counter = 0
    while (!connected) {
        await sleep(1000)
        counter++
        if (counter > 10) {
            log.error("Timeout: server never came alive")
            process.exit(1)
        }
    }

    // Creating or opening a database connection
    database = new ActivityPubStorage("./db.sqlite3")
    log.info("Connected to database")
}
main()

// Start the server
const port = process.env.PORT || 3000
app.listen(port, () => {
    log.info(`ActivityPub server listening on port ${port}`)
    connected = true
})
