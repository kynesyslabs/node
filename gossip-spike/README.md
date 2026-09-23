# gossip-spike

Two-server verification that libp2p gossipsub works under Bun. Each process
joins the `spike/pingpong/1` topic, publishes a PING every 2s, and answers
any peer's PING with a PONG. Round-trip times are printed on the pinging side.

Dependency versions are exact-pinned to the stack verified working under
Bun 1.3.14 on Linux (libp2p 2.10.0 + gossipsub 14.1.2). Do not bump them —
libp2p 3.x has no compatible gossipsub release.

## Two remote servers

On **both** servers (Bun installed, TCP port 9095 open between them):

```sh
# copy this directory to the server, then:
cd gossip-spike
bun install
```

**Server 1** (listener):

```sh
NAME=server1 bun run pingpong.js
```

It prints its peerId and a ready-made command for the other side:

```
[server1] on the OTHER server, run:
    PEER=/ip4/<THIS_SERVER_PUBLIC_IP>/tcp/9095/p2p/12D3KooW... bun run pingpong.js
```

**Server 2** (dialer) — paste that line, substituting server 1's public IP:

```sh
NAME=server2 PEER=/ip4/203.0.113.7/tcp/9095/p2p/12D3KooW... bun run pingpong.js
```

Expected on both sides within a few seconds:

```
[server2] dialed /ip4/203.0.113.7/tcp/9095/p2p/12D3KooW...
[server2] sending PING #1 (topic peers: 1)
[server2] PING #1 from server1 -> sending PONG
[server2] PONG #1 from server1 -- round trip 43ms
```

The dialer retries every 3s until the listener is reachable, so start order
doesn't matter. Ctrl+C stops a node; `stopped cleanly` confirms `node.stop()`
resolves (one of the three originally reported Bun failures).

## Local sanity check (one machine, two terminals)

```sh
# terminal 1
PORT=9095 NAME=a bun run pingpong.js
# terminal 2 — use the p2p line terminal 1 printed, with 127.0.0.1:
PORT=9096 NAME=b PEER=/ip4/127.0.0.1/tcp/9095/p2p/<peerId-from-terminal-1> bun run pingpong.js
```

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `9095` | TCP listen port |
| `PEER` | _(empty)_ | Multiaddr of the other node; empty = listen only |
| `NAME` | hostname | Label used in logs and message payloads |
