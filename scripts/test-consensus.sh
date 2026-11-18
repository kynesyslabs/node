#!/usr/bin/env bash
# Runs the consensus, block-validation and fork suites, one file per process:
# bun shares module mocks across files in one run, and the jest suites depend
# on jest.mock, so each file runs under the runner it was written for.
set -uo pipefail
cd "$(dirname "$0")/.."

SUITE_DIRS=(src/libs/consensus src/libs/blockchain/validation src/forks)
# Single files outside SUITE_DIRS that guard consensus, boot and launch
# safety. A listed file that is gone fails its run instead of dropping out
# silently
SUITE_FILES=(
    scripts/launch-go-no-go.committee.test.ts
    scripts/launch-go-no-go.test.ts
    scripts/launch-go-no-go.snapshot.test.ts
    scripts/launch-go-no-go.plan.test.ts
    scripts/launch-go-no-go.prover.test.ts
    scripts/launch-height1-check.test.ts
    scripts/node-doctor.test.ts
    scripts/validator.test.ts
    scripts/validator-prove-signing.test.ts
    docs/runbooks/dormant-mode.test.ts
    src/config/loader.forkSchedulePolicy.test.ts
    src/config/loader.gossip.test.ts
    src/config/loader.logsDir.test.ts
    src/config/loader.rapidApi.test.ts
    src/config/mainnetParameters.test.ts
    src/config/proxyChecks.test.ts
    src/features/tlsnotary/proxyToken.test.ts
    src/features/tlsnotary/proxyRelay.test.ts
    src/features/tlsnotary/relayTarget.test.ts
    src/features/tlsnotary/notaryUnreachable.test.ts
    src/features/web2/proxy/Proxy.contentType.test.ts
    src/libs/blockchain/blockApplyAtomicity.test.ts
    src/libs/blockchain/blockCommitOutcome.test.ts
    src/libs/blockchain/blockRowStorable.test.ts
    src/libs/blockchain/chainTransactions.insert.test.ts
    src/libs/blockchain/chainTransactions.status.test.ts
    src/libs/blockchain/finality/commitments.test.ts
    src/libs/blockchain/finality/requesterFixtures.test.ts
    src/libs/blockchain/finality/storageHistory.test.ts
    src/libs/blockchain/finality/storageRecord.test.ts
    src/libs/blockchain/finality/storageRoot.test.ts
    src/libs/blockchain/finality/validatorSet.test.ts
    src/libs/blockchain/finality/verify.test.ts
    src/libs/blockchain/gcr/gcr_routines/GCRAtomicStorageRoutines.test.ts
    src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines.granular.test.ts
    src/libs/blockchain/gcr/gcr_routines/hashGCR.storageRoot.test.ts
    src/libs/blockchain/gcr/gcr_routines/routines/zkRoutines.test.ts
    src/libs/blockchain/gcr/handleGCR.atomic.test.ts
    src/libs/blockchain/gcr/handleGCR.failedTx.test.ts
    src/libs/blockchain/gcr/handleGCR.identityRollback.test.ts
    src/libs/blockchain/gcr/handleGCR.keyRefusal.test.ts
    src/libs/blockchain/gcr/handleGCR.l2psSettlement.test.ts
    src/libs/blockchain/gcr/handleGCR.nativeValue.test.ts
    src/libs/blockchain/gcr/gcr_routines/routines/identityCarryover.test.ts
    src/libs/blockchain/gcr/gcr_routines/routines/identityContextKeys.test.ts
    src/libs/blockchain/gcr/handleGCR.nonceIntegrity.test.ts
    src/libs/blockchain/gcr/handleGCR.supply.test.ts
    src/libs/blockchain/gcr/handleGCR.tlsnOnchain.test.ts
    src/libs/blockchain/gcr/stagedWrites.test.ts
    src/libs/blockchain/gcr/storageLeafWrite.test.ts
    src/libs/blockchain/gcr/storableRows.test.ts
    src/libs/blockchain/mempool.nonceIntegrity.test.ts
    src/libs/blockchain/mempool.editBinding.test.ts
    src/libs/blockchain/mempool.nextBlockRef.test.ts
    src/libs/blockchain/mempool.receive.test.ts
    src/libs/blockchain/routines/Sync.mergePeerlist.test.ts
    src/libs/blockchain/routines/Sync.orphanRollback.test.ts
    src/libs/blockchain/routines/Sync.verification.test.ts
    src/libs/blockchain/routines/syncVerification.test.ts
    src/libs/blockchain/routines/validateTransaction.feeBalance.test.ts
    src/libs/blockchain/routines/validateTransaction.nonceWindow.test.ts
    src/libs/blockchain/routines/validateTransaction.valueRules.test.ts
    src/libs/blockchain/routines/validatorsManagement.typecheck.test.ts
    src/libs/blockchain/sdkTypes.typecheck.test.ts
    src/libs/communications/broadcastManager.syncData.test.ts
    src/libs/consensus/v2/types/secretaryManager.timeout.test.ts
    src/libs/crypto/canonicalJson.test.ts
    src/libs/debug/nonceTrace.test.ts
    src/libs/gossip/GossipManager.lifecycle.test.ts
    src/libs/gossip/sidecarHealth.test.ts
    src/libs/gossip/txPublishPeers.test.ts
    src/libs/crypto/merkle/rfc6962.test.ts
    src/libs/crypto/merkle/sparse.test.ts
    src/libs/identity/foreignSignature.test.ts
    src/libs/identity/signingRecord.test.ts
    src/libs/identity/tools/twitter.request.test.ts
    src/libs/identity/web2Unlink.test.ts
    src/libs/network/broadcastDisposition.test.ts
    src/libs/network/broadcastReferenceWindow.test.ts
    src/libs/network/endpointValidation.admissionReason.test.ts
    src/libs/network/handlers/getAddressInfo.test.ts
    src/libs/network/handlers/getMempool.test.ts
    src/libs/network/handlers/getTxByHash.test.ts
    src/libs/network/handlers/tlsnotaryGetInfo.test.ts
    src/libs/network/handlers/requestTlsnProxy.test.ts
    src/libs/network/helloGenesisGate.test.ts
    src/libs/network/manageConsensusRoutines.commitLock.test.ts
    src/libs/network/manageConsensusRoutines.committed.test.ts
    src/libs/network/outboundEntryGate.test.ts
    src/libs/network/proposeBlockHashSender.test.ts
    src/libs/network/rateLimiter.loopback.test.ts
    src/libs/network/rpcGossipSize.test.ts
    src/libs/network/routines/nodecalls/finalityProofCalls.test.ts
    src/libs/network/routines/nodecalls/getFinalizedHead.test.ts
    src/libs/network/routines/nodecalls/readApi.test.ts
    src/libs/network/routines/nodecalls/requesterFixtures.head.test.ts
    src/libs/network/routines/nodecalls/requesterFixtures.status.test.ts
    src/libs/network/rpcEditBinding.test.ts
    src/libs/omniprotocol/integration/BaseAdapter.test.ts
    src/libs/omniprotocol/peerAuthBinding.test.ts
    src/libs/omniprotocol/peerLiveness.test.ts
    src/libs/peer/routines/anchorPairing.test.ts
    src/libs/omniprotocol/server/preauthLimits.test.ts
    src/libs/omniprotocol/transport/ConnectionPool.connectTimeout.test.ts
    src/libs/omniprotocol/transport/ConnectionPool.perPeerCap.test.ts
    src/libs/omniprotocol/transport/preauthBuffering.test.ts
    src/libs/peer/routines/checkOfflinePeers.test.ts
    src/libs/peer/routines/peerBootstrap.test.ts
    src/libs/peer/syncClaims.test.ts
    src/libs/tlsnotary/httpTranscript.test.ts
    src/libs/tlsnotary/storedPresentation.test.ts
    src/libs/tlsnotary/tlsnOnchainPg.test.ts
    src/libs/tlsnotary/tlsnVerifiedIdentity.test.ts
    src/libs/tlsnotary/wasmVerifier.test.ts
    src/libs/utils/clockProbe.test.ts
    src/libs/utils/keyMaker.test.ts
    src/model/datasource.test.ts
    src/model/dbPreflight.test.ts
    src/utilities/nodeVersion.test.ts
    src/utilities/tui/CategorizedLogger.level.test.ts
    testing/consensus/forkScheduleAbstainRoutine.test.ts
    testing/forks/disableForkMachineryFlag.test.ts
    testing/forks/loadForkConfig.test.ts
    testing/forks/web2ProofBindingWiring.test.ts
    testing/genesis/acceptedForkSchedule.test.ts
    testing/genesis/buildGenesisBlock.test.ts
    testing/genesis/findGenesisBlock.requireValidators.test.ts
    testing/genesis/forkScheduleAbstain.test.ts
    testing/genesis/forkScheduleAgreement.test.ts
    testing/genesis/forkScheduleWatch.test.ts
    testing/genesis/genesisHashTool.test.ts
    testing/genesis/genesisMismatch.test.ts
    testing/genesis/genesisPin.test.ts
    testing/genesis/genesisSchedule.test.ts
    testing/genesis/identityCarryover.test.ts
    testing/genesis/normalizeGenesisForHash.test.ts
    testing/genesis/restoreSnapshot.hashAtRestore.test.ts
    tests/web2/proxy.test.ts
    src/libs/abstraction/web2/githubToken.test.ts
    scripts/test-consensus.registration.test.ts
    # Apply determinism, identity admission and sudo auth (launch rows 3, 7, 8)
    src/features/incentive/pointsApplyPure.test.ts
    src/libs/blockchain/gcr/applyTime.test.ts
    src/libs/blockchain/gcr/gcr_routines/identityManager.xmBinding.test.ts
    src/libs/blockchain/gcr/gcr_routines/noAccountRowsOutsideApply.test.ts
    src/libs/blockchain/gcr/gcr_routines/routines/scoreIdentityRoutines.test.ts
    src/libs/blockchain/gcr/gcr_routines/routines/zkAttestationContext.test.ts
    src/libs/blockchain/genesis/genesisSeedingTime.test.ts
    src/libs/identity/humanPassportClaimGate.test.ts
    src/libs/identity/providers/scoreRefresh.test.ts
    src/libs/network/authReplayCache.test.ts
    src/libs/network/httpBodyBinding.test.ts
    src/libs/network/manageGCRRoutines.humanPassportClaim.test.ts
    src/libs/network/manageGCRRoutines.readOnly.test.ts
    src/libs/omniprotocol/protocol/noConsensusStateWrites.test.ts
    src/libs/l2ps/l2psAggregatorSettlement.test.ts
    src/libs/l2ps/l2psAggregatorTeardown.test.ts
    src/libs/l2ps/l2psApplyTime.test.ts
    src/libs/l2ps/l2psSettlementOldPath.test.ts
    src/libs/l2ps/settlement/aggregator.test.ts
    src/libs/l2ps/settlement/bootCheck.test.ts
    src/libs/l2ps/settlement/encoding.test.ts
    src/libs/l2ps/settlement/planner.test.ts
    src/libs/l2ps/settlement/transfer.test.ts
    src/libs/l2ps/settlement/validation.test.ts
    src/libs/network/peerHttpAuth.test.ts
    src/libs/network/sudoReplayFloor.test.ts
    src/libs/network/tlsnotaryRoutesGate.test.ts
    scripts/sudo-call.test.ts
    testing/loadgen/src/features/gcr/gcr_points_smoke.test.ts
)

list_suite_files() {
    find "${SUITE_DIRS[@]}" -name '*.test.ts'
    printf '%s\n' "${SUITE_FILES[@]}"
}

if [ "${1:-}" = "--list" ]; then
    list_suite_files | sort -u
    exit 0
fi

# Sharding. Unset means one shard holding everything, so the default invocation
# is unchanged. Set by the CI matrix, or passed as "--shard INDEX/TOTAL".
#
# The split is LPT (longest processing time first) over measured per-file
# durations in scripts/consensus-weights.tsv, when that file covers the suite.
# Round-robin over the sorted list by file count is the fallback.
#
# LPT is what makes the split actually even. Round-robin is even by COUNT, but
# files differ by two orders of magnitude (the slowest measured file is 48s, the
# median is 4s), so counting files left one shard ~30% slower than the others.
# Both strategies produce an exact partition: every file in exactly one shard,
# no duplicates, no gaps.
#
# The weights file is data, not a maintained promise. If it is missing, or if it
# does not cover every file in the suite, this falls back to round-robin rather
# than packing on a partial table -- a stale table would silently skew the split,
# and a missing file has no weight to place.
SHARD_INDEX="${SHARD_INDEX:-}"
SHARD_TOTAL="${SHARD_TOTAL:-}"
if [ "${1:-}" = "--shard" ]; then
    SHARD_INDEX="${2%%/*}"
    SHARD_TOTAL="${2#*/}"
    if [ "$SHARD_TOTAL" = "$2" ]; then
        echo "::error::--shard expects INDEX/TOTAL, got '$2'"
        exit 2
    fi
fi
SHARD_INDEX="${SHARD_INDEX:-1}"
SHARD_TOTAL="${SHARD_TOTAL:-1}"

case "$SHARD_INDEX$SHARD_TOTAL" in
    ''|*[!0-9]*)
        echo "::error::shard index and total must be integers, got '$SHARD_INDEX/$SHARD_TOTAL'"
        exit 2
        ;;
esac
if [ "$SHARD_TOTAL" -lt 1 ]; then
    echo "::error::shard total must be at least 1, got '$SHARD_TOTAL'"
    exit 2
fi
if [ "$SHARD_INDEX" -lt 1 ] || [ "$SHARD_INDEX" -gt "$SHARD_TOTAL" ]; then
    echo "::error::shard index must be between 1 and $SHARD_TOTAL, got '$SHARD_INDEX'"
    exit 2
fi

# Build this shard's file list.
#
# With weights: LPT packs the suite onto SHARD_TOTAL bins, then this shard prints
# the bin it owns. The packing is deterministic -- same inputs, same bins -- so
# every shard independently computes the same assignment without coordinating.
# Without weights: round-robin by position in the sorted list.
#
# The total is carried in the summary line so a shard that was handed an empty
# slice can be told apart from a suite that has genuinely lost its tests.
WEIGHTS_FILE="$(cd "$(dirname "$0")/.." && pwd)/scripts/consensus-weights.tsv"

shard_files() {
    if [ -f "$WEIGHTS_FILE" ] && awk -F'\t' -v tot="$SHARD_TOTAL" -v idx="$SHARD_INDEX" '
        # Pass 1: collect weights and the suite. Pass 2: emit this shard.
        FNR == NR {
            if (NF >= 2) w[$1] = $2
            next
        }
        { suite[++n] = $0 }
        END {
            # Every suite file must have a weight, or packing would place an
            # unweighted file as if it were free. Fall back instead.
            for (i = 1; i <= n; i++) if (!(suite[i] in w)) exit 1
            if (n == 0 || tot < 1 || idx < 1 || idx > tot) exit 1

            # LPT: heaviest first, each onto the currently lightest bin.
            for (i = 1; i <= n; i++) order[i] = suite[i]
            for (i = 2; i <= n; i++) {
                key = order[i]; j = i - 1
                while (j >= 1 && w[order[j]] < w[key]) { order[j+1] = order[j]; j-- }
                order[j+1] = key
            }
            for (i = 1; i <= tot; i++) load[i] = 0
            for (i = 1; i <= n; i++) {
                best = 1
                for (b = 2; b <= tot; b++) if (load[b] < load[best]) best = b
                load[best] += w[order[i]]
                bin[order[i]] = best
            }
            for (i = 1; i <= n; i++) if (bin[suite[i]] == idx) print suite[i]
        }
    ' "$WEIGHTS_FILE" - < <(list_suite_files | sort -u); then
        return 0
    fi
    # Fallback: no weights, or weights that do not cover the suite.
    awk -v idx="$SHARD_INDEX" -v tot="$SHARD_TOTAL" '((NR - 1) % tot) == (idx - 1)'
}

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
done < <(list_suite_files | sort -u | shard_files)

echo "consensus suites: $count files in shard $SHARD_INDEX/$SHARD_TOTAL, ${#failed[@]} failed"
if [ "$count" -eq 0 ]; then
    # A single-shard run must never silently pass having tested nothing, so that
    # stays a hard failure. In a multi-shard run an empty slice is legitimate
    # only when the suite has fewer files than shards; warn rather than fail, and
    # rely on the other shards plus the aggregate job to notice a lost suite.
    if [ "$SHARD_TOTAL" -eq 1 ]; then
        echo "::error::no test files found under ${SUITE_DIRS[*]}"
        exit 1
    fi
    echo "::warning::shard $SHARD_INDEX/$SHARD_TOTAL received no files (suite smaller than shard count)"
fi
# `${failed[@]:-}` rather than `${failed[@]}`: with `set -u`, bash below 4.4
# treats an empty array as an unbound variable and aborts the script even though
# every test passed. Bash 5 (the CI runner) accepts the plain form, so this was
# invisible there -- but it makes a no-failure run impossible to reproduce
# locally on macOS, which is exactly the case a shard hits routinely.
for file in "${failed[@]:-}"; do
    echo "  FAILED $file"
done
[ "${#failed[@]}" -eq 0 ]
