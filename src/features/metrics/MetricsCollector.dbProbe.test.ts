// MetricsCollector.start() and its DbProbe: a start() whose first collection
// threw leaves `running` false, so the node may call start() again. That retry
// must not leave the first probe's timer ticking next to the new one.
//
// pingDatabase, the probe query: on abort it must give up its pool client even
// though Postgres never answers (a half-open connection), with real pg, pg-pool
// and a TypeORM query runner against a fake Postgres server.
import { describe, expect, it, mock, spyOn } from "bun:test"
import net from "node:net"
import { DataSource } from "typeorm"
import { DbProbe } from "./dbProbe"
import { MetricsCollector, pingDatabase } from "./MetricsCollector"

const timerOf = (probe: DbProbe) =>
    (probe as unknown as { timer: unknown }).timer

describe("MetricsCollector.start() with the DbProbe", () => {
    it("a second start() after a first one that threw leaves exactly one probe timer running", async () => {
        // No query: the probe's ticks do nothing, so the DataSource is never loaded.
        const tick = spyOn(DbProbe.prototype, "tick").mockResolvedValue(undefined)
        const started: DbProbe[] = []
        const originalStart = DbProbe.prototype.start
        DbProbe.prototype.start = function (this: DbProbe) {
            started.push(this)
            originalStart.call(this)
        }

        const collector = MetricsCollector.getInstance()
        let collections = 0
        ;(collector as unknown as { collectAll: () => Promise<void> }).collectAll =
            async () => {
                collections++
                if (collections === 1) throw new Error("first collection failed")
            }

        try {
            await expect(collector.start()).rejects.toThrow("first collection failed")
            expect(started).toHaveLength(1)
            expect(timerOf(started[0])).not.toBeNull()

            await collector.start()
            expect(started).toHaveLength(2)
            const running = started.filter(p => timerOf(p) !== null)
            expect(running).toHaveLength(1)
            expect(running[0]).toBe(started[1])

            collector.stop()
            expect(started.filter(p => timerOf(p) !== null)).toHaveLength(0)
        } finally {
            collector.stop()
            DbProbe.prototype.start = originalStart
            tick.mockRestore()
        }
    })
})

/**
 * Enough of the Postgres wire protocol (v3) for pg to connect without a
 * password and run a simple query. While `hang` is set, a query gets no answer.
 */
function fakePostgres() {
    const state = { hang: true, connections: 0, queries: 0 }
    const waiters = { query: [] as Array<() => void>, close: [] as Array<() => void> }
    const sockets = new Set<net.Socket>()
    const message = (type: string, body: Buffer) => {
        const head = Buffer.alloc(5)
        head.write(type, 0, "ascii")
        head.writeInt32BE(body.length + 4, 1)
        return Buffer.concat([head, body])
    }
    const authOk = message("R", Buffer.alloc(4))
    const ready = message("Z", Buffer.from("I"))
    const selectDone = message("C", Buffer.from("SELECT 1\0"))

    const server = net.createServer(socket => {
        state.connections++
        sockets.add(socket)
        socket.on("error", () => undefined)
        socket.on("close", () => {
            sockets.delete(socket)
            waiters.close.splice(0).forEach(wake => wake())
        })
        let started = false
        let buffered: Buffer = Buffer.alloc(0)
        socket.on("data", (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk])
            for (;;) {
                // The startup message has no type byte.
                const offset = started ? 1 : 0
                if (buffered.length < offset + 4) return
                const end = offset + buffered.readInt32BE(offset)
                if (buffered.length < end) return
                const type = started ? String.fromCharCode(buffered[0]) : ""
                buffered = buffered.subarray(end)
                if (!started) {
                    started = true
                    socket.write(Buffer.concat([authOk, ready]))
                } else if (type === "Q") {
                    state.queries++
                    waiters.query.splice(0).forEach(wake => wake())
                    if (!state.hang) socket.write(Buffer.concat([selectDone, ready]))
                } else if (type === "X") {
                    socket.end()
                }
            }
        })
    })

    return {
        state,
        listen: () =>
            new Promise<number>(resolve =>
                server.listen(0, "127.0.0.1", () =>
                    resolve((server.address() as net.AddressInfo).port),
                ),
            ),
        nextQuery: () => new Promise<void>(r => waiters.query.push(r)),
        nextClose: () => new Promise<void>(r => waiters.close.push(r)),
        close: () => {
            sockets.forEach(s => s.destroy())
            server.close()
        },
    }
}

interface PgPool {
    totalCount: number
    idleCount: number
    on(event: "error", listener: (error: unknown) => void): void
    end(): Promise<void>
}

describe("pingDatabase", () => {
    it("on abort ends its pool client and settles without an answer; the next probe connects afresh", async () => {
        const pg = fakePostgres()
        const port = await pg.listen()
        const dataSource = new DataSource({
            type: "postgres",
            host: "127.0.0.1",
            port,
            username: "probe",
            database: "probe",
        })
        // The pg that TypeORM loaded, one connection at most: the second probe
        // only gets one if the first gave its slot back.
        const pgModule = (
            dataSource.driver as unknown as {
                postgres: { Pool: new (options: object) => PgPool }
            }
        ).postgres
        const pool = new pgModule.Pool({
            host: "127.0.0.1",
            port,
            user: "probe",
            database: "probe",
            max: 1,
        })
        // As TypeORM's createPool does; nothing should reach it here.
        const poolErrors: unknown[] = []
        pool.on("error", error => poolErrors.push(error))
        ;(dataSource.driver as unknown as { master: PgPool }).master = pool
        ;(dataSource as unknown as { isInitialized: boolean }).isInitialized = true
        mock.module("@/model/datasource", () => ({ dataSource }))

        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => unhandled.push(reason)
        process.on("unhandledRejection", onUnhandled)

        try {
            // Postgres never answers the first SELECT 1.
            const asked = pg.nextQuery()
            const controller = new AbortController()
            const first = pingDatabase(controller.signal)
            await asked
            expect(pool.totalCount).toBe(1)

            const closed = pg.nextClose()
            controller.abort(new Error("no answer within 5000 ms"))
            // It settles although the query never gets an answer.
            const outcome = await Promise.race([
                first.then(
                    () => "resolved",
                    (error: Error) => error.message,
                ),
                new Promise(r => setTimeout(() => r("still pending"), 1_000)),
            ])
            expect(outcome).toBe("no answer within 5000 ms")
            // The client left the pool instead of going back to it...
            expect(pool.totalCount).toBe(0)
            expect(pool.idleCount).toBe(0)
            // ...and its socket was closed.
            await closed

            // Postgres answers again: a fresh connection, released for reuse.
            pg.state.hang = false
            await pingDatabase(new AbortController().signal)
            expect(pg.state.connections).toBe(2)
            expect(pg.state.queries).toBe(2)
            expect(pool.totalCount).toBe(1)
            expect(pool.idleCount).toBe(1)

            // The destroyed client's query rejected quietly: no pool error, no
            // unhandled rejection.
            await new Promise(r => setTimeout(r, 20))
            expect(poolErrors).toEqual([])
            expect(unhandled).toEqual([])
        } finally {
            process.off("unhandledRejection", onUnhandled)
            // Server first: that also frees a client a failing run left hung,
            // so pool.end() does not wait for it forever.
            pg.close()
            await pool.end()
        }
    })
})
