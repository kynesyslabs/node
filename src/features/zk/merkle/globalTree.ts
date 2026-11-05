/**
 * The one identity commitment tree every node keeps. Its capacity is fixed by
 * its depth: a commitment beyond it cannot be inserted.
 */
export const GLOBAL_TREE_ID = "global"
export const GLOBAL_TREE_DEPTH = 20
export const GLOBAL_TREE_CAPACITY = 2 ** GLOBAL_TREE_DEPTH
