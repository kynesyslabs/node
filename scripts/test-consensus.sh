#!/usr/bin/env bash
# Runs the consensus, block-validation and fork suites, one file per process:
# bun shares module mocks across files in one run, and the jest suites depend
# on jest.mock, so each file runs under the runner it was written for.
set -uo pipefail
cd "$(dirname "$0")/.."

SUITE_DIRS=(src/libs/consensus src/libs/blockchain/validation src/forks)
# Single files outside SUITE_DIRS that guard consensus, boot, launch and logging
# safety. A listed file that is gone fails its run instead of dropping out
# silently
SUITE_FILES=(
    scripts/check-secret-logs.test.ts
    scripts/launch-go-no-go.committee.test.ts
    scripts/launch-go-no-go.test.ts
    scripts/launch-go-no-go.snapshot.test.ts
    scripts/launch-go-no-go.plan.test.ts
    scripts/launch-go-no-go.bots.test.ts
    scripts/launch-go-no-go.prover.test.ts
    scripts/launch-height1-check.test.ts
    scripts/node-doctor.test.ts
    scripts/validator.test.ts
    scripts/validator-prove-signing.test.ts
    src/config/loader.debugAssertions.test.ts
    docs/runbooks/dormant-mode.test.ts
    src/config/loader.forkSchedulePolicy.test.ts
    src/config/loader.gossip.test.ts
    src/config/loader.logsDir.test.ts
    src/config/loader.rapidApi.test.ts
    src/config/mainnetParameters.test.ts
    src/config/proxyChecks.test.ts
    src/libs/crypto/keyErrorLogging.test.ts
    src/features/tlsnotary/proxyToken.test.ts
    src/features/tlsnotary/proxyRelay.test.ts
    src/features/tlsnotary/relayTarget.test.ts
    src/features/tlsnotary/notaryUnreachable.test.ts
    src/features/tlsnotary/tokenCreate.test.ts
    src/features/web2/proxy/Proxy.contentType.test.ts
    src/features/metrics/dbProbe.test.ts
    src/features/metrics/MetricsCollector.dbProbe.test.ts
    src/libs/blockchain/blockApplyAtomicity.test.ts
    src/libs/blockchain/blockCommitOutcome.test.ts
    src/libs/blockchain/blockRowStorable.test.ts
    src/libs/blockchain/chainBlocks.storedHead.test.ts
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
    src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines.recreate.test.ts
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
    src/libs/blockchain/routines/Sync.signerBoundary.test.ts
    src/libs/blockchain/validation/verifyBlock.test.ts
    src/libs/blockchain/validation/verifyBlock.crypto.test.ts
    src/libs/blockchain/validation/signerRule.test.ts
    src/libs/blockchain/routines/syncVerification.test.ts
    src/libs/blockchain/routines/validateTransaction.feeBalance.test.ts
    src/libs/blockchain/routines/validateTransaction.fees.test.ts
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
    src/utilities/shutdownExitStatus.test.ts
    src/utilities/tui/CategorizedLogger.level.test.ts
    testing/monitoring/metricsExposure.test.ts
    testing/consensus/forkScheduleAbstainRoutine.test.ts
    testing/forks/disableForkMachineryFlag.test.ts
    testing/forks/governanceTxHash.test.ts
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
    testing/loadgen/src/features/gcr/gcr_identity_loadgen.test.ts
    testing/loadgen/src/features/gcr/gcr_points_smoke.test.ts
    # Loadgen error logging (#708), including the guard against silent catches
    testing/loadgen/src/features/omni/close_log.test.ts
    testing/loadgen/src/features/peersync/shared.test.ts
    testing/loadgen/src/features/peersync/snapshot_reply_log.test.ts
    testing/loadgen/src/features/tlsnotary/shared.test.ts
    testing/loadgen/src/framework/common.test.ts
    testing/loadgen/src/framework/rpc_json_log.test.ts
    testing/loadgen/src/framework/silent_catch.test.ts
    testing/loadgen/src/rpc_ready_log.test.ts
    testing/loadgen/src/token_holders_export.test.ts
    testing/loadgen/src/token_names_from_runs.test.ts
    testing/loadgen/src/token_script_complex_policy_amounts.test.ts
    testing/loadgen/src/token_script_complex_policy_object_amounts.test.ts
    testing/loadgen/src/token_settle_check_balance_log.test.ts
    testing/loadgen/src/token_total_supply_log.test.ts
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
# Files are dealt round-robin over the stable sorted list rather than packed by
# measured duration: the per-file timings that would make packing better are not
# collected anywhere yet, and guessing them would produce an uneven split that
# looks considered. Round-robin keeps the split exact -- every file lands in
# exactly one shard, no gaps and no duplicates -- and is close to even by count.
SHARD_INDEX="${SHARD_INDEX:-}"
SHARD_TOTAL="${SHARD_TOTAL:-}"
if [ "${1:-}" = "--shard" ]; then
    # Capture the raw argument before shifting it away: the validation below
    # compares against it, and any named files that follow must survive in $@.
    _shard_arg="${2:-}"
    SHARD_INDEX="${_shard_arg%%/*}"
    SHARD_TOTAL="${_shard_arg#*/}"
    if [ "$SHARD_TOTAL" = "$_shard_arg" ]; then
        echo "::error::--shard expects INDEX/TOTAL, got '$_shard_arg'"
        exit 2
    fi
    shift 2 || true
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

# Build this shard's file list. The total is carried in the summary line so a
# shard that was handed an empty slice can be told apart from a suite that has
# genuinely lost its tests.
shard_files() {
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
    if [[ "$(runner_for "$file")" = jest ]]; then
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
# The candidate list is either the files named on the command line or the whole
# suite; the shard then selects its portion of that list. Both features compose:
# `--shard 2/4` narrows the suite, and `--shard 2/4 <files...>` narrows the named
# subset the same way.
done < <(
    if [[ "$#" -gt 0 ]]; then
        printf '%s\n' "$@"
    else
        list_suite_files
    fi | sort -u | shard_files
)

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
# Guarded rather than written as `for file in "${failed[@]}"`: with `set -u`,
# bash below 4.4 treats an empty array as an unbound variable and aborts the
# script even though every test passed. Bash 5 (the CI runner) accepts the plain
# form, so the abort was invisible there -- but it made a no-failure run
# impossible to reproduce locally on macOS, which is exactly the case a shard
# hits routinely. Testing the length first keeps that fix from printing a
# spurious "FAILED" line on a shard that passed.
if [ "${#failed[@]}" -gt 0 ]; then
    for file in "${failed[@]}"; do
        echo "  FAILED $file"
    done
fi
[ "${#failed[@]}" -eq 0 ]
