#!/usr/bin/env bash
# Runs the consensus, block-validation and fork suites, one file per process:
# bun shares module mocks across files in one run, and the jest suites depend
# on jest.mock, so each file runs under the runner it was written for.
set -uo pipefail
cd "$(dirname "$0")/.."

SUITE_DIRS=(src/libs/consensus src/libs/blockchain/validation src/forks)
# Single files outside SUITE_DIRS: the launch go/no-go tooling, the signing
# guards and the consensus and sync routes the suites depend on. A listed
# file that is gone fails its run instead of dropping out silently
SUITE_FILES=(
    scripts/launch-go-no-go.committee.test.ts
    scripts/launch-go-no-go.test.ts
    scripts/launch-go-no-go.snapshot.test.ts
    scripts/validator-prove-signing.test.ts
    src/libs/blockchain/routines/Sync.mergePeerlist.test.ts
    src/libs/communications/broadcastManager.syncData.test.ts
    src/libs/identity/foreignSignature.test.ts
    src/libs/identity/signingRecord.test.ts
    src/libs/network/helloGenesisGate.test.ts
    src/libs/network/manageConsensusRoutines.commitLock.test.ts
    src/libs/network/manageConsensusRoutines.committed.test.ts
    src/libs/network/proposeBlockHashSender.test.ts
    src/libs/peer/syncClaims.test.ts
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
