# Missing StorageProgram Query Endpoints

## Summary

The Demos node at `node2.demos.sh` currently supports StorageProgram **write** transactions
(`CREATE_STORAGE_PROGRAM`, `WRITE_STORAGE`) but returns `501 Method not implemented` for all
**read/query** RPC methods. These methods are invoked via the `nodeCall` RPC mechanism — a POST
request to the node with `{ method: "nodeCall", params: [{ message: "<METHOD_NAME>", data: {...}, muid: "..." }] }`.

The SDK expects a response shape of `{ result: 200, response: <payload> }` on success.

A total of **9 RPC message handlers** are missing. Until they are implemented, the only workaround
is replaying state from `getTransactionHistory` — which is slow, brittle, and not scalable.

**Test contract:** `stor-30556b12e724b0e7c7c45ef920df7ea822cad04c` — a deployed StorageProgram with JSON data (multi-user registry with alice/bob entries). Good address to probe against when implementing these endpoints.

---

## RPC Transport

All query methods below are sent as HTTP POST to the node URL with the following envelope:

```json
{
  "method": "nodeCall",
  "params": [
    {
      "message": "<RPC_METHOD_NAME>",
      "data": { ... },
      "muid": "storage-<timestamp>"
    }
  ]
}
```

Success response envelope:

```json
{ "result": 200, "response": <payload> }
```

---

## Missing Endpoints

### 1. `getStorageProgram`

- **RPC Method Name:** `getStorageProgram`
- **SDK Method:** `StorageProgram.getByAddress(rpcUrl, storageAddress, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramData`
  ```typescript
  {
    storageAddress: string;          // "stor-<hash>"
    owner: string;                   // "demos1..."
    programName: string;
    encoding: "json" | "binary";
    data?: Record<string, unknown> | string | null;
    metadata?: Record<string, unknown> | null;
    storageLocation: string;         // "onchain" or other
    sizeBytes: number;
    createdAt: string;               // ISO timestamp
    updatedAt: string;               // ISO timestamp
    createdByTx?: string;            // tx hash
    lastModifiedByTx?: string;       // tx hash
    interactionTxs?: string[];       // all tx hashes that touched this program
  }
  ```
- **Description:** Fetches the full storage program record by its address. Respects ACL — if
  `requesterAddress` is provided it is used for access control checks; otherwise only public
  programs are readable. Returns `null` (or a 404) if not found.

---

### 2. `getStorageProgramAll`

- **RPC Method Name:** `getStorageProgramAll`
- **SDK Method:** `StorageProgram.getAll(rpcUrl, storageAddress, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramData` (same shape as `getStorageProgram` above)
- **Description:** Alias/variant of `getStorageProgram` that is explicitly intended to return the
  full data payload (as opposed to a summary). In practice the SDK treats these as equivalent — the
  node may implement both with the same handler or differentiate them (e.g. `getStorageProgram`
  could omit `data` while `getStorageProgramAll` always includes it). Either approach is acceptable
  as long as both return the full `StorageProgramData` shape.

---

### 3. `getStorageProgramsByOwner`

- **RPC Method Name:** `getStorageProgramsByOwner`
- **SDK Method:** `StorageProgram.getByOwner(rpcUrl, owner, identity?)`
- **Request Parameters:**
  ```json
  {
    "owner": "demos1...",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramListItem[]`
  ```typescript
  Array<{
    storageAddress: string;      // "stor-<hash>"
    programName: string;
    encoding: "json" | "binary";
    sizeBytes: number;
    storageLocation: string;
    createdAt: string;           // ISO timestamp
    updatedAt: string;           // ISO timestamp
  }>
  ```
- **Description:** Returns a list of all storage programs owned by the given address. The list
  items intentionally omit the full `data` payload — callers follow up with `getStorageProgram` or
  `getStorageProgramAll` for individual program data. Should return an empty array (not an error)
  when the owner has no programs.

---

### 4. `searchStoragePrograms`

- **RPC Method Name:** `searchStoragePrograms`
- **SDK Method:** `StorageProgram.searchByName(rpcUrl, nameQuery, options?)`
- **Request Parameters:**
  ```json
  {
    "query": "partialOrFullName",
    "options": {
      "limit": 10,           // optional, number
      "offset": 0,           // optional, number (for pagination)
      "exactMatch": false    // optional, boolean
    },
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramListItem[]` (same shape as `getStorageProgramsByOwner`)
- **Description:** Full-text / partial name search across all storage programs. When `exactMatch`
  is `false` (the default), the `query` string should match any program whose `programName`
  contains it as a substring (case-insensitive preferred). When `exactMatch` is `true`, only exact
  name matches are returned. Supports pagination via `limit` and `offset`. Should return an empty
  array (not an error) when there are no matches.

---

### 5. `getStorageProgramFields`

- **RPC Method Name:** `getStorageProgramFields`
- **SDK Method:** `StorageProgram.getFields(rpcUrl, storageAddress, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramFieldsResponse`
  ```typescript
  {
    fields: string[];   // top-level key names in the JSON data object
    count: number;      // fields.length
  }
  ```
- **Description:** Returns the list of top-level field (key) names present in a JSON-encoded
  storage program. Only applicable to programs with `encoding: "json"`. Should return `null` (or
  an appropriate error) for binary-encoded programs.

---

### 6. `getStorageProgramValue`

- **RPC Method Name:** `getStorageProgramValue`
- **SDK Method:** `StorageProgram.getValue(rpcUrl, storageAddress, field, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "field": "fieldName",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramValueResponse`
  ```typescript
  {
    field: string;                                                         // echoes the requested field name
    value: unknown;                                                        // the field's current value
    type: "string" | "number" | "boolean" | "array" | "object" | "null" | "undefined";
  }
  ```
- **Description:** Returns the current value of a single named field from a JSON-encoded storage
  program, along with its JavaScript type. Only applicable to `encoding: "json"` programs.

---

### 7. `getStorageProgramItem`

- **RPC Method Name:** `getStorageProgramItem`
- **SDK Method:** `StorageProgram.getItem(rpcUrl, storageAddress, field, index, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "field": "arrayFieldName",
    "index": 0,
    "requesterAddress": "<optional demos1... address>"
  }
  ```
  Note: `index` supports negative values (`-1` = last element).
- **Expected Response:** `StorageProgramItemResponse`
  ```typescript
  {
    field: string;        // echoes the requested field name
    index: number;        // the resolved (non-negative) index actually accessed
    value: unknown;       // the item at that index
    arrayLength: number;  // total length of the array
  }
  ```
- **Description:** Returns a single element from an array-typed field within a JSON-encoded storage
  program. Supports negative indexing (e.g. `-1` returns the last element). Should return `null`
  (or an error) if the field is not an array or if the index is out of bounds.

---

### 8. `hasStorageProgramField`

- **RPC Method Name:** `hasStorageProgramField`
- **SDK Method:** `StorageProgram.hasField(rpcUrl, storageAddress, field, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "field": "fieldName",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramHasFieldResponse`
  ```typescript
  {
    field: string;   // echoes the requested field name
    exists: boolean;
  }
  ```
- **Description:** Checks whether a named field exists in a JSON-encoded storage program without
  returning its value. Useful for cheap existence checks before performing a full `getValue` call.
  Only applicable to `encoding: "json"` programs.

---

### 9. `getStorageProgramFieldType`

- **RPC Method Name:** `getStorageProgramFieldType`
- **SDK Method:** `StorageProgram.getFieldType(rpcUrl, storageAddress, field, identity?)`
- **Request Parameters:**
  ```json
  {
    "storageAddress": "stor-<40-char-hash>",
    "field": "fieldName",
    "requesterAddress": "<optional demos1... address>"
  }
  ```
- **Expected Response:** `StorageProgramFieldTypeResponse`
  ```typescript
  {
    field: string;
    type: "string" | "number" | "boolean" | "array" | "object" | "null" | "undefined";
  }
  ```
- **Description:** Returns only the type of a named field without fetching its value. Primarily
  used to guard array operations — callers check `type === "array"` before calling
  `getStorageProgramItem`. Only applicable to `encoding: "json"` programs.

---

## Priority Ranking

Implement in this order to unblock SDK consumers as quickly as possible:

| Priority | RPC Method                   | Reason                                                                                   |
|----------|------------------------------|------------------------------------------------------------------------------------------|
| 1        | `getStorageProgram`          | Core read operation — every read flow starts here. Blocks all other usage.               |
| 2        | `getStorageProgramAll`       | Used by `StorageProgram.getAll()`; many consumers call this instead of `getByAddress`.  |
| 3        | `getStorageProgramsByOwner`  | Required to enumerate programs owned by an address (dashboard / management UIs).         |
| 4        | `getStorageProgramFields`    | Needed to discover the schema of a JSON program before reading individual fields.        |
| 5        | `getStorageProgramValue`     | Needed to read a single field efficiently without fetching the full program.             |
| 6        | `searchStoragePrograms`      | Needed for name-based discovery; lower urgency than direct-address reads.                |
| 7        | `hasStorageProgramField`     | Convenience existence check; can be emulated by calling `getStorageProgramValue`.        |
| 8        | `getStorageProgramFieldType` | Type guard for array operations; can be emulated via `getStorageProgramValue`.           |
| 9        | `getStorageProgramItem`      | Array-element access; can be emulated via `getStorageProgramAll` + client-side indexing. |

---

## Current Workaround

Until these endpoints are implemented, state can be reconstructed by calling
`getTransactionHistory` for the relevant address and replaying all `CREATE_STORAGE_PROGRAM`,
`WRITE_STORAGE`, `SET_FIELD`, `SET_ITEM`, `APPEND_ITEM`, `DELETE_FIELD`, and `DELETE_ITEM`
transactions in order. This approach is correct but has significant drawbacks:

- Requires fetching and processing an unbounded number of transactions.
- Does not scale as transaction history grows.
- Cannot efficiently answer field-level or item-level queries.
- Provides no ACL enforcement at the node level.

This workaround is not suitable for production use and should be treated as a temporary measure only.
