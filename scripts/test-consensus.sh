#!/usr/bin/env bash
# Runs the consensus, block-validation and fork suites, one file per process:
# bun shares module mocks across files in one run, and the jest suites depend
# on jest.mock, so each file runs under the runner it was written for.
set -uo pipefail
cd "$(dirname "$0")/.."

SUITE_DIRS=(src/libs/consensus src/libs/blockchain/validation src/forks)
# Single files outside SUITE_DIRS: the launch go/no-go tooling, the signing
# guards, the consensus and sync routes the suites depend on, the peer
# liveness checks that decide which committee members count, the read calls
# clients use to tell whether a transaction executed and which head is
# final, the version every report names, the fork-schedule agreement and
# abstain rules, the Omni pre-auth limits, atomic block apply (its database
# is faked, so no Postgres), the finality proof calls and their offline
# verifier, the hashing primitives finality commitments are built on, and
# the storage state root with the writes and sync checks that feed it. A
# listed file that is gone fails its run instead of dropping out silently
SUITE_FILES=(
    scripts/launch-go-no-go.committee.test.ts
    scripts/launch-go-no-go.test.ts
    scripts/launch-go-no-go.snapshot.test.ts
    scripts/validator-prove-signing.test.ts
    src/libs/blockchain/blockApplyAtomicity.test.ts
    src/libs/blockchain/chainTransactions.status.test.ts
    src/libs/blockchain/finality/commitments.test.ts
    src/libs/blockchain/finality/storageRecord.test.ts
    src/libs/blockchain/finality/storageRoot.test.ts
    src/libs/blockchain/finality/validatorSet.test.ts
    src/libs/blockchain/finality/verify.test.ts
    src/libs/blockchain/gcr/gcr_routines/hashGCR.storageRoot.test.ts
    src/libs/blockchain/gcr/stagedWrites.test.ts
    src/libs/blockchain/gcr/storageLeafWrite.test.ts
    src/libs/blockchain/routines/Sync.mergePeerlist.test.ts
    src/libs/blockchain/routines/Sync.verification.test.ts
    src/libs/blockchain/routines/syncVerification.test.ts
    src/libs/communications/broadcastManager.syncData.test.ts
    src/libs/crypto/canonicalJson.test.ts
    src/libs/crypto/merkle/rfc6962.test.ts
    src/libs/crypto/merkle/sparse.test.ts
    src/libs/identity/foreignSignature.test.ts
    src/libs/identity/signingRecord.test.ts
    src/libs/network/handlers/getAddressInfo.test.ts
    src/libs/network/handlers/getMempool.test.ts
    src/libs/network/handlers/getTxByHash.test.ts
    src/libs/network/helloGenesisGate.test.ts
    src/libs/network/manageConsensusRoutines.commitLock.test.ts
    src/libs/network/manageConsensusRoutines.committed.test.ts
    src/libs/network/proposeBlockHashSender.test.ts
    src/libs/network/routines/nodecalls/finalityProofCalls.test.ts
    src/libs/network/routines/nodecalls/getFinalizedHead.test.ts
    src/libs/network/routines/nodecalls/readApi.test.ts
    src/libs/omniprotocol/peerAuthBinding.test.ts
    src/libs/omniprotocol/peerLiveness.test.ts
    src/libs/omniprotocol/server/preauthLimits.test.ts
    src/libs/omniprotocol/transport/preauthBuffering.test.ts
    src/libs/peer/routines/checkOfflinePeers.test.ts
    src/libs/peer/syncClaims.test.ts
    src/libs/utils/calibrateTime.boot.test.ts
    src/utilities/nodeVersion.test.ts
    testing/consensus/forkScheduleAbstainRoutine.test.ts
    testing/forks/loadForkConfig.test.ts
    testing/genesis/acceptedForkSchedule.test.ts
    testing/genesis/buildGenesisBlock.test.ts
    testing/genesis/forkScheduleAbstain.test.ts
    testing/genesis/forkScheduleAgreement.test.ts
    testing/genesis/forkScheduleWatch.test.ts
    testing/genesis/genesisHashTool.test.ts
    testing/genesis/genesisMismatch.test.ts
    testing/genesis/genesisPin.test.ts
    testing/genesis/normalizeGenesisForHash.test.ts
)

runner_for() {
    if grep -q 'from "bun:test"' "$1"; then
        echo bun
    elif grep -q 'jest\.' "$1"; then
        echo jest
    else
        echo bun
    fi
}

failed=()
count=0
while IFS= read -r file; do
    count=$((count + 1))
    echo "::group::$file ($(runner_for "$file"))"
    if [ "$(runner_for "$file")" = jest ]; then
        npx jest --maxWorkers=1 "$file" < /dev/null
    else
        bun test "./$file" < /dev/null
    fi
    status=$?
    echo "::endgroup::"
    if [ "$status" -ne 0 ]; then
        failed+=("$file")
        echo "::error file=$file::test file failed"
    fi
done < <({ find "${SUITE_DIRS[@]}" -name '*.test.ts'; printf '%s\n' "${SUITE_FILES[@]}"; } | sort -u)

echo "consensus suites: $count files, ${#failed[@]} failed"
if [ "$count" -eq 0 ]; then
    echo "::error::no test files found under ${SUITE_DIRS[*]}"
    exit 1
fi
for file in "${failed[@]}"; do
    echo "  FAILED $file"
done
[ "${#failed[@]}" -eq 0 ]
