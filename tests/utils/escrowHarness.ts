/**
 * In-memory stand-in for the gcr_main repository used by GCREscrowRoutines.
 * findOne returns copies and only save() writes, like a real database.
 * A transaction that throws restores the rows it started with.
 */
export class FakeGcrDb {
    rows = new Map<string, any>()
    saved: string[] = []

    addAccount(
        pubkey: string,
        balance: bigint,
        extra: Record<string, any> = {},
    ) {
        this.rows.set(pubkey, {
            pubkey,
            balance,
            flagged: false,
            escrows: {},
            ...extra,
        })
    }

    get(pubkey: string) {
        return this.rows.get(pubkey)
    }

    repository(): any {
        const entityManager = {
            findOne: async (_entity: unknown, options: any) => {
                const row = this.rows.get(options.where.pubkey)
                return row ? structuredClone(row) : null
            },
            save: async (entities: any) => {
                for (const entity of [].concat(entities)) {
                    this.rows.set(entity.pubkey, structuredClone(entity))
                    this.saved.push(entity.pubkey)
                }
                return entities
            },
        }
        return {
            manager: {
                transaction: async (callback: (em: any) => Promise<any>) => {
                    const snapshot = new Map(
                        [...this.rows].map(([k, v]) => [k, structuredClone(v)]),
                    )
                    try {
                        return await callback(entityManager)
                    } catch (error) {
                        this.rows = snapshot
                        throw error
                    }
                },
            },
        }
    }
}

/** Mirrors HandleGCR.createAccount: saves through the global repository unless persist is false */
export function fakeCreateAccount(db: () => FakeGcrDb) {
    return async (
        pubkey: string,
        _fill: Record<string, any> = {},
        persist = true,
    ) => {
        const account = { pubkey, balance: 0n, flagged: false, escrows: {} }
        if (persist) {
            db().rows.set(pubkey, structuredClone(account))
            db().saved.push(pubkey)
        }
        return account
    }
}

/** Module mocks shared by the escrow tests (pass to jest.mock factories) */
export const mockLogger = () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
})
