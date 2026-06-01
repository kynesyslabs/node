import type { Logger, QueryRunner } from "typeorm"
import { CategorizedLogger } from "src/utilities/tui"

const SLOW_QUERY_THRESHOLD_MS = 50

export class QueryTimingLogger implements Logger {
    private readonly logger = CategorizedLogger.getInstance()

    logQuery(
        query: string,
        parameters?: any[],
        _queryRunner?: QueryRunner,
    ): void {
        // const paramStr = parameters?.length ? ` -- params: ${JSON.stringify(parameters)}` : ""
        // this.logger.debug("DB", `${query}${paramStr}`)
    }

    logQuerySlow(
        time: number,
        query: string,
        parameters?: any[],
        _queryRunner?: QueryRunner,
    ): void {
        const paramStr = parameters?.length
            ? ` -- params: ${JSON.stringify(parameters)}`
            : ""
        if (time >= SLOW_QUERY_THRESHOLD_MS) {
            this.logger.warning("DB", `⚠️⚠️ ${time}ms — ${query}${paramStr}`)
        }

        // else {
        //     this.logger.info("DB", `${time}ms — ${query}${paramStr}`)
        // }
    }

    logQueryError(
        error: string | Error,
        query: string,
        parameters?: any[],
        _queryRunner?: QueryRunner,
    ): void {
        const paramStr = parameters?.length
            ? ` -- params: ${JSON.stringify(parameters)}`
            : ""
        const errorMsg = error instanceof Error ? error.message : error
        this.logger.error(
            "DB",
            `QUERY ERROR: ${errorMsg} — ${query}${paramStr}`,
        )
    }

    logSchemaBuild(message: string): void {
        this.logger.debug("DB", `Schema: ${message}`)
    }

    logMigration(message: string): void {
        this.logger.info("DB", `Migration: ${message}`)
    }

    log(level: "log" | "info" | "warn", message: any): void {
        switch (level) {
            case "warn":
                this.logger.warning("DB", String(message))
                break
            default:
                this.logger.info("DB", String(message))
        }
    }
}
