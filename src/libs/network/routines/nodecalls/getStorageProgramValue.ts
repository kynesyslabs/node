import {
    getValueType,
    rpc,
    withFieldRead,
} from "./storageProgramShared"

/**
 * Get a single field's value from a JSON storage program.
 *
 * JSON-only: binary-encoded programs return 400 / INVALID_FIELD_TYPE.
 * Field-not-found returns 404 / FIELD_NOT_FOUND (matches the HTTP route).
 * Returns null when the program is missing / soft-deleted (200/null).
 *
 * The validate-resolve-checkType-checkField envelope is shared with sibling
 * field-read handlers; see {@link withFieldRead}.
 */
export default withFieldRead(
    "getStorageProgramValue",
    ({ field, value }) => rpc(200, { field, value, type: getValueType(value) }),
)
