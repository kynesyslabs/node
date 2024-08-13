# Comlink

The `comlink` method is used to send a Comlink request to a node.

Comlink is a protocol that allows for the creation of a secure chain of messages between nodes, peers and clients in general.

## Request format

The `comlink` method is a POST request that must contain the following fields:

```json
{
    "method": "comlink",
    "params": [comlink_object]
}
```
You can find the full definition of the `comlink_object` in the [Comlink specification](../../Specifications/Comlink/Comlink.md).