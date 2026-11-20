import type { BlockContent } from "@kynesyslabs/demosdk/types"

/**
 * Block 0's content as this node stores it. The SDK declares `extra` only on
 * its GenesisBlockContent and types `genesisData` there as the parsed
 * genesis, but buildGenesisBlock stores it as JSON text (see
 * parseStoredGenesisData), so callers get `unknown` and parse it themselves.
 */
export type StoredGenesisBlockContent = BlockContent & {
    extra?: { genesisData?: unknown }
}

/**
 * Types the content of block 0 as block 0's. Returns its argument unchanged:
 * callers keep their own property reads, so their null handling is as before.
 */
export function asGenesisBlockContent(
    content: BlockContent,
): StoredGenesisBlockContent {
    return content
}
