import { EntityTarget, Repository, FindOptionsOrder } from "typeorm"
import Datasource from "../../../../model/datasource"
import Hashing from "src/libs/crypto/hashing"
import { GCRSubnetsTxs } from "../../../../model/entities/GCRv2/GCRSubnetsTxs"
import { GlobalChangeRegistry } from "../../../../model/entities/GCR/GlobalChangeRegistry"
import { GCRHashes } from "../../../../model/entities/GCRv2/GCRHashes"
import { GCRTracker } from "src/model/entities/GCR/GCRTracker"

/** Example
        // Get top-level values
        const tokens = await GCRJsonbHandler.getJSONBValue(
            "publicKey",
            "extended",
            "tokens",
        )

        // Get nested values
        const balance = await GCRJsonbHandler.getJSONBValue(
            "publicKey",
            "details",
            "content",
            "balance",
        )
        const nonce = await GCRJsonbHandler.getJSONBValue(
            "publicKey",
            "details",
            "content",
            "nonce",
        )
    */
export async function getJSONBValue(
    publicKey: string,
    field: "extended" | "details",
    key: string,
    subkey?: string,
) {
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GlobalChangeRegistry)

    const jsonPath = subkey
        ? `gcr.${field}->'${key}'->>'${subkey}'`
        : `gcr.${field}->>'${key}'`

    return await GCRRepository.createQueryBuilder("gcr")
        .select(jsonPath)
        .where("gcr.publicKey = :publicKey", { publicKey })
        .getRawOne()
}

/** Example
    // Update top-level values
    await GCRJsonbHandler.updateJSONBValue(
        "publicKey",
        "extended",
        "tokens",
        ["token1", "token2"],
    )

    // Update nested values
        await GCRJsonbHandler.updateJSONBValue(
        "publicKey",
        "details",
        "content",
        "balance",
        1000,
    )

    // Update multiple nested values at once
await GCRJsonbHandler.updateJSONBValue(
        "publicKey",
        "details",
        "content",
        { balance: 1000, nonce: 5 },
    )
    */
export async function updateJSONBValue(
    publicKey: string,
    field: "extended" | "details",
    key: string,
    value: any,
    subkey?: string,
) {
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GlobalChangeRegistry)

    const jsonPath = subkey ? `{${key}, ${subkey}}` : `{${key}}`

    // Convert value to JSON string and escape single quotes
    const jsonValue = JSON.stringify(value).replace(/'/g, "''")

    return await GCRRepository.createQueryBuilder()
        .update(GlobalChangeRegistry)
        .set({
            [field]: () =>
                `jsonb_set(${field}, '${jsonPath}', '${jsonValue}'::jsonb, true)`,
        })
        .where("publicKey = :publicKey", { publicKey })
        .execute()
}
