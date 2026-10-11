import { mock } from "bun:test"

// Several node modules open a Postgres connection at import time through
// Datasource.getInstance(). These unit tests never touch the database, so the
// datasource is replaced with an inert stub before any node module loads.
const fakeDatasource = {
    getInstance: async () => ({
        getDataSource: () => ({ getRepository: () => ({}) }),
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
