import { UnifiedCrypto } from "@kynesyslabs/demosdk/encryption"
import * as forge from "node-forge"
import fs from "fs"
import path from "path"
// TODO Import L2PSConfig from sdks once is available

/**
 * ParallelNetworks is the main class for interacting with L2PSes within a node .
 * Is a multi-singleton class
 */
export default class ParallelNetworks {
    // private l2pses: Map<string, L2PS> = new Map()

    constructor() {

    }

    static async getConfig(uid: string) { // : Promise<L2PS> { 
        // REVIEW: Get the config from data/l2ps/[id]/config.json
        const configPath = path.join(process.cwd(), "data", "l2ps", uid, "config.json")
        if (!fs.existsSync(configPath)) {
            throw new Error("Config file not found")
        }
        const config = JSON.parse(fs.readFileSync(configPath, "utf8")) // TODO Use L2PSConfig from sdks once is available
        if (!config.uid) {
            throw new Error("Config file is invalid")
        }

        // REVIEW Load the key from data/l2ps/[id]/key.json or asc or whatever it is
        const keyPath = path.join(process.cwd(), "data", "l2ps", uid, "key.asc")
        if (!fs.existsSync(keyPath)) {
            throw new Error("Key file not found")
        }
        const key = fs.readFileSync(keyPath, "utf8")
        // TODO Create the L2PS instance with the sdk when is available
        // const l2ps = await L2PS.create(key)
        // l2ps.config = config
        // TODO Set the L2PS instance to the map
        // this.l2pses.set(uid, l2ps)
        // TODO Return the L2PS instance
        // return this.l2pses.get(uid)

    }
}