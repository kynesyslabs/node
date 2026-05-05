import {
    getValueType,
    rpc,
    withFieldRead,
} from "./storageProgramShared"

/**
 * Get the JSON type of a top-level field on a storage program.
 *
 * JSON-only: binary-encoded programs return 400 / INVALID_FIELD_TYPE.
 * Field-not-found returns 404 / FIELD_NOT_FOUND (matches the HTTP route at
 * features/storageprogram/routes.ts:513-578).
 * Returns null when the program is missing / soft-deleted (200/null).
 *
 * The validate-resolve-checkType-checkField envelope is shared with sibling
 * field-read handlers; see {@link withFieldRead}.
 */
export default withFieldRead(
    "getStorageProgramFieldType",
    ({ field, value }) => rpc(200, { field, type: getValueType(value) }),
)
