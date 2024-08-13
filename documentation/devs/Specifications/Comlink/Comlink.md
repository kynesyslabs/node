# Comlink Specifications

Comlink is a protocol that allows for the creation of a secure chain of messages between nodes, peers and clients in general.

## Comlink Object

The `comlink_object` is an object expressing the Comlink class as defined in `src/libs/communications/comlink.ts`.

Besides the class methods and singleton logics expressed in the codebase, the `comlink_object` must contain the following fields:

```json
{
    // [...] Singleton logic
    chain: {
        current: Current
        comlinkCurrentHash: string
        comlinkCurrentHashSignature: forge.pki.ed25519.BinaryBuffer
    }
    muid: string
    properties: Properties
    // [...] Constructor and methods
}
```

### Sub types

#### `Current`

You can find the full definition of the `Current` type in the [Comlink specification](../../Specifications/Comlink/Current.md).

#### `forge.pki.ed25519.BinaryBuffer`

This type is derived from `node-forge`'s `pki.ed25519.BinaryBuffer`.

#### `Properties`

TODO