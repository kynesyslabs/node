#!/usr/bin/env bash
# Runs the consensus, block-validation and fork suites, one file per process:
# bun shares module mocks across files in one run, and the jest suites depend
# on jest.mock, so each file runs under the runner it was written for.
set -uo pipefail
cd "$(dirname "$0")/.."

SUITE_DIRS=(src/libs/consensus src/libs/blockchain/validation src/forks)

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
        npx jest --maxWorkers=1 "$file"
    else
        bun test "./$file"
    fi
    status=$?
    echo "::endgroup::"
    if [ "$status" -ne 0 ]; then
        failed+=("$file")
        echo "::error file=$file::test file failed"
    fi
done < <(find "${SUITE_DIRS[@]}" -name '*.test.ts' | sort)

echo "consensus suites: $count files, ${#failed[@]} failed"
if [ "$count" -eq 0 ]; then
    echo "::error::no test files found under ${SUITE_DIRS[*]}"
    exit 1
fi
for file in "${failed[@]}"; do
    echo "  FAILED $file"
done
[ "${#failed[@]}" -eq 0 ]
