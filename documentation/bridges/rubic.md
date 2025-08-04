# Rubic Bridge Documentation

Rubic Brdige Service is located in the `src/features/bridges/rubic.ts` file

`getTrade` method

Interface

```ts
export interface BridgeTradePayload {
    fromToken: "NATIVE" | "USDC" | "USDT";
    toToken: "NATIVE" | "USDC" | "USDT";
    amount: number;
    fromChainId: number;
    toChainId: number;
}
```

This method is responsible for calculating and retrieving the best cross-chain trade option based on the provided parameters.
Returns the best trade option or an error if no valid trades are found.

`executeTrade` method

The Interface is imported from the `rubic-sdk` package

```ts
wrappedTrade: WrappedCrossChainTrade
```

The method interacts with the SDK to manage the trade swap, allowance, approval, transaction submission, and confirmation.
Returns transaction receipt.

`manageBridges` function is located in `src/libs/network/manageBridges.ts` file
Handles the calls comming from the `sdks` for the `get_trade`, `execute_trade` cases.
