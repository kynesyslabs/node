/**
 * Unified Configuration Module
 *
 * Single source of truth for all environment-based configuration.
 * Replaces scattered process.env reads with typed, validated config.
 *
 * Usage:
 *   import { Config } from "src/config"
 *   const cfg = Config.getInstance()
 *   cfg.server.rpcPort    // number, typed
 *   cfg.core.prod         // boolean, typed
 *   cfg.tlsnotary.port    // number, typed
 *
 * The config is loaded once at first access and deeply frozen.
 * All env vars are read from process.env via the loader.
 * Default values are defined in defaults.ts.
 * Env var names are constants in envKeys.ts (no magic strings).
 */

import { loadConfig } from "./loader"
import type {
    AppConfig,
    ServerConfig,
    DatabaseConfig,
    CoreConfig,
    TLSNotaryConfig,
    OmniConfig,
    L2PSConfig,
    MetricsConfig,
    DiagnosticsConfig,
    IdentityConfig,
    BridgesConfig,
    IPFSConfig,
} from "./types"

export class Config {
    private static instance: Config
    private readonly data: Readonly<AppConfig>

    private constructor() {
        this.data = loadConfig()
    }

    public static getInstance(): Config {
        if (!Config.instance) {
            Config.instance = new Config()
        }
        return Config.instance
    }

    /** Reset singleton (for testing only) */
    public static resetInstance(): void {
        Config.instance = undefined as unknown as Config
    }

    // --- Typed accessors per domain section ---

    get server(): Readonly<ServerConfig> {
        return this.data.server
    }

    get database(): Readonly<DatabaseConfig> {
        return this.data.database
    }

    get core(): Readonly<CoreConfig> {
        return this.data.core
    }

    get tlsnotary(): Readonly<TLSNotaryConfig> {
        return this.data.tlsnotary
    }

    get omni(): Readonly<OmniConfig> {
        return this.data.omni
    }

    get l2ps(): Readonly<L2PSConfig> {
        return this.data.l2ps
    }

    get metrics(): Readonly<MetricsConfig> {
        return this.data.metrics
    }

    get diagnostics(): Readonly<DiagnosticsConfig> {
        return this.data.diagnostics
    }

    get identity(): Readonly<IdentityConfig> {
        return this.data.identity
    }

    get bridges(): Readonly<BridgesConfig> {
        return this.data.bridges
    }

    get ipfs(): Readonly<IPFSConfig> {
        return this.data.ipfs
    }

    /** Full config snapshot (read-only) */
    get all(): Readonly<AppConfig> {
        return this.data
    }

    set omniPort(port: number) {
        this.data.omni.port = port
    }
}

// Re-exports
export { EnvKey } from "./envKeys"
export { DEFAULT_CONFIG } from "./defaults"
export { loadConfig } from "./loader"
export type {
    AppConfig,
    ServerConfig,
    DatabaseConfig,
    CoreConfig,
    TLSNotaryConfig,
    OmniConfig,
    L2PSConfig,
    MetricsConfig,
    DiagnosticsConfig,
    IdentityConfig,
    BridgesConfig,
    IPFSConfig,
} from "./types"
