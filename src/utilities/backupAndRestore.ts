import { Client } from "pg"
import * as fs from "fs"
import * as path from "path"
import * as dotenv from "dotenv"
import { Config } from "src/config"
dotenv.config()

interface UserBalance {
    id: number
    username: string
    balance: number
    genesis_balance: [string, number]
    [key: string]: any // For any other fields in the table
}

interface OutputData {
    users: UserBalance[]
    genesis_balances: [string, number][]
}

async function dumpUserData(): Promise<void> {
    const pgPort = Config.getInstance().database.port
    console.log("PG_PORT: " + pgPort)
    // Database connection configuration
    const dbConfig = {
        user: "demosuser",
        password: "demospassword",
        host: "127.0.0.1",
        port: pgPort,
        database: "demos", // Assuming this is the database name
        table: "gcr_main",
    }

    // Create a new PostgreSQL client
    const client = new Client(dbConfig)

    try {
        // Connect to the database
        console.log("Connecting to PostgreSQL database...")
        await client.connect()
        console.log("Connected successfully!")

        // Query to get all fields for users (minus faucet addresses)
        // TODO: REMOVE THE WHERE CLAUSE AFTER FIRST RESTORE
        const query = `SELECT * FROM ${dbConfig.table} WHERE balance < 10000000000000`

        // Execute the query
        console.log("Executing query...")
        let result
        try {
            result = await client.query(query)
            console.log(
                `Found ${result.rows.length} users with positive balance.`,
            )
        } catch (error) {
            console.error("Error dumping GCR table:", error.toString())
        }

        if (!result) {
            return
        }

        const userBalances = result.rows

        // Extract all genesis_balance entries into a separate array
        const genesisBalances: [string, number][] = userBalances.map(user => [
            user.pubkey,
            user.balance,
        ])

        // Create the output data structure
        const outputData: OutputData = {
            users: userBalances,
            genesis_balances: genesisBalances,
        }

        // Create output directory if it doesn't exist
        const outputDir = path.join(process.cwd(), "output")
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }

        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const outputPath = path.join(
            outputDir,
            `user-balances-${timestamp}.json`,
        )

        // Write the data to a JSON file
        await fs.promises.writeFile(
            outputPath,
            JSON.stringify(outputData),
            "utf8",
        )

        console.log(`Balance data has been saved to: ${outputPath}`)
    } catch (error) {
        console.error("Error:", error)
    } finally {
        // Close the database connection
        await client.end()
        console.log("Database connection closed.")
    }
}

// Execute the function
await dumpUserData()
