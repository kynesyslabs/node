/** Rationale
 * The whole concept of the native bridge is to manage addresses and smart contracts
 * to allow the users to deposit on one side and withdraw on the other side.
 * Each chain has its own management class, depending on the chain type.
 * For example, Solana utilizes on-the-fly address creation and management
 * while EVM chains utilize smart contracts (tanks) to manage the deposits and withdrawals.
 * 
 * REVIEW stablecoinManagement is used to manage the stablecoins in a handy way.
 * 
 * BridgingOperations is used to manage the operations of the native bridge and
 * orchestrates the operations between the different chains through the management classes.
 * 
 * For further information, please refer to the schema `gas_tanks_workflow.drawio.png`
 * in the documentation folder.
 */
export * from "./BridgingOperations"
export * from "./stablecoinManagement"
export * from "./supportedAssets"
export * from "./solanaAddressManagement"
export * from "./EVMSmartContractManagement"