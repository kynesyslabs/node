import { mock } from "bun:test"

// Several node modules open a Postgres connection at import time through
// Datasource.getInstance(). These unit tests never touch the database, so the
// datasource is replaced with an inert stub before any node module loads.
// Tests that need a repository can set `testDatabase.repository`.
export const testDatabase: { repository: any } = { repository: {} }

const fakeDatasource = {
    getInstance: async () => ({
        getDataSource: () => ({ getRepository: () => testDatabase.repository }),
    }),
}
mock.module("src/model/datasource", () => ({
    default: fakeDatasource,
    dataSource: {},
}))
mock.module("@/model/datasource", () => ({
    default: fakeDatasource,
    dataSource: {},
}))
