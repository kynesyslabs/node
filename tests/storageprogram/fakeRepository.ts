import _ from "lodash"

/**
 * Minimal in-memory stand-in for the TypeORM GCR_Main repository, covering
 * only the calls HandleGCR.applyStorageProgramEdit makes.
 */
export class FakeGCRMainRepository {
    rows = new Map<string, any>()

    async findOne(options: { where: { pubkey: string } }) {
        const row = this.rows.get(options.where.pubkey)
        return row ? _.cloneDeep(row) : null
    }

    create(entity: any) {
        return _.cloneDeep(entity)
    }

    async save(entity: any) {
        this.rows.set(entity.pubkey, _.cloneDeep(entity))
        return entity
    }

    async delete(criteria: { pubkey: string }) {
        const existed = this.rows.delete(criteria.pubkey)
        return { affected: existed ? 1 : 0 }
    }
}
