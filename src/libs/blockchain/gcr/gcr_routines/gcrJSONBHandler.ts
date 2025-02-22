import Datasource from "../../../../model/datasource"
import { GCR_Main } from "@/model/entities/GCRv2/GCR_Main"

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
    pubkey: string,
    field: "identities" | "assignedTxs",
    key: string,
    subkey?: string,
) {
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GCR_Main)

    const jsonPath = subkey
        ? `gcr.${field}->'${key}'->>'${subkey}'`
        : `gcr.${field}->>'${key}'`

    return await GCRRepository.createQueryBuilder("gcr")
        .select(jsonPath)
        .where("gcr.pubkey = :pubkey", { pubkey })
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
    pubkey: string,
    field: "assignedTxs" | "identities",
    key: string,
    value: any,
    subkey?: string,
) {
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GCR_Main)

    const jsonPath = subkey ? `{${key}, ${subkey}}` : `{${key}}`

    // Convert value to JSON string and escape single quotes
    const jsonValue = JSON.stringify(value).replace(/'/g, "''")

    return await GCRRepository.createQueryBuilder()
        .update(GCR_Main)
        .set({
            [field]: () =>
                `jsonb_set(${field}, '${jsonPath}', '${jsonValue}'::jsonb, true)`,
        })
        .where("pubkey = :pubkey", { pubkey })
        .execute()
}
