# Transmission specifications

The `Transmission` object is the object contained in the `Current` field of a Comlink.

## Transmission object

The `Transmission` object is an object with the following properties:

```json
{
    bundle: {
        content: {
            type: string;
            message: string;
            sender: any;
            receiver: any;
            timestamp: number;
            data: any;
            extra: string;
        }
        hash: string;
        signature: any;
    }
    receiver_peer: Peer
    privateKey: forge.pki.ed25519.BinaryBuffer
}
```

The `forge.pki.ed25519.BinaryBuffer` type is derived from `node-forge`'s `pki.ed25519.BinaryBuffer`.

TODO Do peer interface