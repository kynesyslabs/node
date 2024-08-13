# Current specifications

The `Current` object is the current state of the Comlink. It expresses the message being sent through the Comlink and its chain of messages hash.

## Current object

The current object is an object with the following properties:

```json
{
    currentMessage: Transmission
    currentMessageHash: string
    previousHashes: string[]
}
```

You can find the full definition of the `Transmission` type in the [Comlink specification](../../Specifications/Comlink/Transmission.md).