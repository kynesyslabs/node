#!/usr/bin/env python3
"""Genesis files for the acceptance scenarios, derived from an image's own
data/genesis.json. Python keeps integer literals exact, which a JSON.parse
round trip would not for 18-digit stakes.

Writes into --out:
  launch.json       the launch genesis: fixed timestamp, chain id, the
                    mainnet forks at height 0, every other known fork
                    declared, snapshot bound by its manifest
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

# Same list as MAINNET_FORKS in scripts/launch-go-no-go.ts; a test keeps them equal
MAINNET_FORKS = ["osDenomination", "nonceEnforcement", "signatureDomain", "editBinding", "nonceIntegrity", "quorumParity", "committeeBinding", "commitLock", "finalityProofs", "identityCarryover", "stakeApplyChecks", "txTypeAllowList", "instantMessagingBinding", "nativeSendBinding", "canonicalAddresses", "feeBinding", "blockCaps", "unpinnedCommittee", "telegramSenderBinding", "xmRemoveCanonical", "tokenStakingGate", "gasFeeSeparation", "web2ProofBinding", "tlsnProofEnforcement", "xmProofBinding", "storageFeeSettlement", "referenceBlockRoom10", "l2psSettlement", "tlsnVerified", "keylessWeb2Identity"]
# Same list as KNOWN_FORKS in scripts/launch-go-no-go.ts; a test keeps them equal.
# A node on a mainnet chain id refuses a genesis that leaves one undeclared.
# Same list as LAUNCH_DORMANT_FORKS in scripts/launch-go-no-go.ts
LAUNCH_DORMANT_FORKS = ["atomicWork", "networkGovernance", "tokenStaking", "l2psGate", "tlsnDisabled"]
KNOWN_FORKS = ["osDenomination", "gasFeeSeparation", "tlsnProofEnforcement", "web2ProofBinding", "xmProofBinding", "signatureDomain", "nonceEnforcement", "atomicWork", "editBinding", "nonceIntegrity", "quorumParity", "committeeBinding", "commitLock", "finalityProofs", "identityCarryover", "stakeApplyChecks", "networkGovernance", "txTypeAllowList", "instantMessagingBinding", "nativeSendBinding", "canonicalAddresses", "feeBinding", "blockCaps", "tokenStakingGate", "tokenStaking", "unpinnedCommittee", "telegramSenderBinding", "xmRemoveCanonical", "l2psSettlement", "l2psGate", "tlsnDisabled", "storageFeeSettlement", "referenceBlockRoom10", "tlsnVerified", "keylessWeb2Identity"]
# The image genesis carries no tlsnVerified payload and the node refuses the fork
# scheduled without one, so the launch genesis takes the devnet's test keys
# (testing/devnet/genesis.devnet.json)
TLSN_VERIFIED = {
    "notaryKeys": [
        {"id": "devnet-test-notary-1", "alg": "k256", "hex": "024a6fdca826ecf9f2e89584bdc4cae0d865019aefb625040fe55174507693c15e"},
        {"id": "devnet-test-notary-2", "alg": "k256", "hex": "030a8177a685c7f3c5aac81689a2e8011284b53843d91dda3113bfac99b9195870"},
    ],
    "verifierWasmSha256": "5ed9774dd485266227b633504beba4cb3bed47c26af01b817ed128ce8517e455",
    "maxPresentationBytes": 65536,
    "freshnessWindowSec": 3600,
    "futureSkewSec": 60,
}

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
# A fork's own payload (gasFeeSeparation's treasury, from the base genesis) is kept
for name in MAINNET_FORKS:
    forks[name] = {**(forks.get(name) or {}), "activationHeight": 0}
if "notaryKeys" not in forks["tlsnVerified"]:
    forks["tlsnVerified"] = {**TLSN_VERIFIED, **forks["tlsnVerified"]}
# The rest stay off
for name in KNOWN_FORKS:
    forks.setdefault(name, {"activationHeight": None})
# Off at launch whatever the image's own genesis schedules, as on mainnet
for name in LAUNCH_DORMANT_FORKS:
    forks[name] = {"activationHeight": None}
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
