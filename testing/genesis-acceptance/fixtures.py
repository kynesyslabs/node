#!/usr/bin/env python3
"""Genesis files for the acceptance scenarios, derived from an image's own
data/genesis.json. Python keeps integer literals exact, which a JSON.parse
round trip would not for 18-digit stakes.

Writes into --out:
  launch.json       the launch genesis: fixed timestamp, chain id, the five
                    mainnet forks at height 0, snapshot bound by its manifest
  onebyte.json      launch with the timestamp one second later
  forkpast.json     launch with commitLock moved to height 1 (inside tip + 50)
  forkfar.json      launch with atomicWork scheduled at 1000000 (beyond the window)
  unknownfork.json  launch with a fork this build cannot know, scheduled far ahead
"""
import argparse
import copy
import hashlib
import json
import os

MAINNET_FORKS = ["signatureDomain", "editBinding", "quorumParity", "committeeBinding", "commitLock"]

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True, help="the image's data/genesis.json")
ap.add_argument("--manifest", required=True, help="the snapshot manifest.json the launch genesis binds")
ap.add_argument("--out", required=True)
ap.add_argument("--chain-id", type=int, required=True)
ap.add_argument("--timestamp", type=int, required=True)
ap.add_argument("--far-height", type=int, default=1_000_000)
ap.add_argument("--unknown-fork", default="genesisAcceptanceUnknownFork")
a = ap.parse_args()

with open(a.base) as f:
    base = json.load(f)
if isinstance(base, str):
    base = json.loads(base)
with open(a.manifest, "rb") as f:
    manifest_sha = hashlib.sha256(f.read()).hexdigest()

launch = copy.deepcopy(base)
launch["timestamp"] = a.timestamp
launch.setdefault("properties", {})["id"] = a.chain_id
forks = launch.setdefault("forks", {})
for name in MAINNET_FORKS:
    forks[name] = {"activationHeight": 0}
launch["snapshot"] = {"manifestSha256": manifest_sha}


def write(name, data):
    path = os.path.join(a.out, name)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(path, 0o644)


write("launch.json", launch)

onebyte = copy.deepcopy(launch)
onebyte["timestamp"] = a.timestamp + 1
write("onebyte.json", onebyte)

forkpast = copy.deepcopy(launch)
forkpast["forks"]["commitLock"] = {"activationHeight": 1}
write("forkpast.json", forkpast)

forkfar = copy.deepcopy(launch)
forkfar["forks"]["atomicWork"] = {"activationHeight": a.far_height}
write("forkfar.json", forkfar)

unknown = copy.deepcopy(launch)
unknown["forks"][a.unknown_fork] = {"activationHeight": a.far_height}
write("unknownfork.json", unknown)

print(f"fixtures written to {a.out}; snapshot manifest sha256 {manifest_sha}")
