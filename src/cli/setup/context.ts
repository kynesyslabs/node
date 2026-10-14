import * as path from "node:path"
import { readEnvFile } from "./envFile"

export interface SetupContext {
    /** Directory the node runs from; the loader resolves `data/l2ps` against it. */
    root: string
    envFilePath: string
    /** Effective environment: the env file overlaid by the real process env, as dotenv does. */
    env: Record<string, string | undefined>
    /** The real process environment alone; it overrides the env file. */
    processEnv: Record<string, string | undefined>
}

export function createContext(
    root: string,
    envFileName = ".env",
    processEnv: Record<string, string | undefined> = process.env,
): SetupContext {
    const envFilePath = path.resolve(root, envFileName)
    return {
        root,
        envFilePath,
        env: { ...readEnvFile(envFilePath), ...processEnv },
        processEnv,
    }
}

export const L2PS_DIR = path.join("data", "l2ps")
export const L2PS_ZK_DIR = path.join("src", "libs", "l2ps", "zk")
export const ZK_IDENTITY_VKEY = path.join(
    "src",
    "features",
    "zk",
    "keys",
    "verification_key_merkle.json",
)
