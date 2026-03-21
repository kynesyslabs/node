import { runRpcLoadgen } from "./rpc_loadgen"
import { runTransferLoadgen } from "./transfer_loadgen"
import { runTransferRamp } from "./transfer_ramp"
import { runRpcRamp } from "./rpc_ramp"
import { runTokenSmoke } from "./token_smoke"
import { runTokenTransferLoadgen } from "./token_transfer_loadgen"
import { runTokenTransferRamp } from "./token_transfer_ramp"
import { runTokenMintSmoke } from "./token_mint_smoke"
import { runTokenBurnSmoke } from "./token_burn_smoke"
import { runTokenMintLoadgen } from "./token_mint_loadgen"
import { runTokenBurnLoadgen } from "./token_burn_loadgen"
import { runTokenMintRamp } from "./token_mint_ramp"
import { runTokenBurnRamp } from "./token_burn_ramp"
import { runTokenAclSmoke } from "./token_acl_smoke"
import { runTokenConsensusConsistency } from "./token_consensus_consistency"
import { runTokenQueryCoverage } from "./token_query_coverage"
import { runTokenAclMatrix } from "./token_acl_matrix"
import { runTokenEdgeCases } from "./token_edge_cases"
import { runTokenAclBurnMatrix } from "./token_acl_burn_matrix"
import { runTokenAclPauseMatrix } from "./token_acl_pause_matrix"
import { runTokenAclTransferOwnershipMatrix } from "./token_acl_transfer_ownership_matrix"
import { runTokenAclMultiPermissionMatrix } from "./token_acl_multi_permission_matrix"
import { runTokenAclUpdateAclCompat } from "./token_acl_updateacl_compat"
import { runTokenScriptSmoke } from "./token_script_smoke"
import { runTokenScriptHooksCorrectness } from "./token_script_hooks_correctness"
import { runTokenScriptRejects } from "./token_script_rejects"
import { runTokenScriptTransferLoadgen } from "./token_script_transfer_loadgen"
import { runTokenScriptTransferRamp } from "./token_script_transfer_ramp"
import { runTokenScriptMintLoadgen } from "./token_script_mint_loadgen"
import { runTokenScriptMintRamp } from "./token_script_mint_ramp"
import { runTokenScriptBurnLoadgen } from "./token_script_burn_loadgen"
import { runTokenScriptBurnRamp } from "./token_script_burn_ramp"
import { runTokenScriptUpgradeMidLoad } from "./token_script_upgrade_mid_load"
import { runTokenScriptComplexPolicySmoke } from "./token_script_complex_policy_smoke"
import { runTokenScriptComplexPolicyRamp } from "./token_script_complex_policy_ramp"
import { runTokenScriptComplexPolicyDynamicUpdates } from "./token_script_complex_policy_dynamic_updates"
import { runTokenScriptComplexPolicyVestingLockup } from "./token_script_complex_policy_vesting_lockup"
import { runTokenScriptComplexPolicyEscrowStateMachine } from "./token_script_complex_policy_escrow_state_machine"
import { runTokenSettleCheck } from "./token_settle_check"
import { runTokenObserve } from "./token_observe"
import { runTokenInvariantsKnownHolders } from "./token_invariants_known_holders"
import { runTokenPauseUnderLoad } from "./token_pause_under_load"
import { runTokenHoldersExport } from "./token_holders_export"
import { runImOnlineLoadgen } from "./im_online_loadgen"
import { runImOnlineRamp } from "./im_online_ramp"
import { runImRegisterDiscoverSmoke } from "./features/im/im_register_discover_smoke"
import { runImMessageRoundtrip } from "./features/im/im_message_roundtrip"
import { runFheScalarSmoke } from "./features/fhe/fhe_scalar_smoke"
import { runFheArithmeticSmoke } from "./features/fhe/fhe_arithmetic_smoke"
import { runWeb2UrlValidationSmoke } from "./features/web2/web2_url_validation_smoke"
import { runWeb2SanitizationSmoke } from "./features/web2/web2_sanitization_smoke"
import { runWeb2DahrRejects } from "./features/web2/web2_dahr_rejects"
import { runIncentiveReferralCodeSmoke } from "./features/incentive/incentive_referral_code_smoke"
import { runIncentiveReferralEligibility } from "./features/incentive/incentive_referral_eligibility"
import { runIncentivePointScoreMatrix } from "./features/incentive/incentive_point_score_matrix"
import { runMcpToolFactorySmoke } from "./features/mcp/mcp_tool_factory_smoke"
import { runMcpServerRegistrySmoke } from "./features/mcp/mcp_server_registry_smoke"
import { runMcpServerCreationSmoke } from "./features/mcp/mcp_server_creation_smoke"
import { runMultichainParserRejects } from "./features/multichain/multichain_parser_rejects"
import { runMultichainParserExecuteSmoke } from "./features/multichain/multichain_parser_execute_smoke"
import { runMultichainDispatcherAggregation } from "./features/multichain/multichain_dispatcher_aggregation"
import { runL2psTransactionShapeSmoke } from "./features/l2ps/l2ps_transaction_shape_smoke"
import { runL2psServiceStatusSmoke } from "./features/l2ps/l2ps_service_status_smoke"
import { runL2psStatisticsSnapshot } from "./features/l2ps/l2ps_statistics_snapshot"
import { runL2psRegistryStateSmoke } from "./features/l2ps/l2ps_registry_state_smoke"
import { runL2psParticipantCacheSmoke } from "./features/l2ps/l2ps_participant_cache_smoke"
import { runL2psParticipantDiscoveryResilience } from "./features/l2ps/l2ps_participant_discovery_resilience"
import { runL2psIncrementalSyncSmoke } from "./features/l2ps/l2ps_incremental_sync_smoke"
import { runL2psExchangeParticipationSmoke } from "./features/l2ps/l2ps_exchange_participation_smoke"
import { runL2psConsolidatedHashSmoke } from "./features/l2ps/l2ps_consolidated_hash_smoke"
import { runL2psBatchGroupingSmoke } from "./features/l2ps/l2ps_batch_grouping_smoke"
import { runL2psBatchPayloadSmoke } from "./features/l2ps/l2ps_batch_payload_smoke"
import { runL2psHashServiceCycleSmoke } from "./features/l2ps/l2ps_hash_service_cycle_smoke"
import { runL2psBatchNonceProgressionSmoke } from "./features/l2ps/l2ps_batch_nonce_progression_smoke"
import { runL2psBatchSubmissionSmoke } from "./features/l2ps/l2ps_batch_submission_smoke"
import { runL2psBatchSubmissionZkRejects } from "./features/l2ps/l2ps_batch_submission_zk_rejects"
import { runL2psProcessBatchForUidSmoke } from "./features/l2ps/l2ps_process_batch_for_uid_smoke"
import { runL2psHashProcessNetworkSmoke } from "./features/l2ps/l2ps_hash_process_network_smoke"
import { runL2psHashesStoreSmoke } from "./features/l2ps/l2ps_hashes_store_smoke"
import { runL2psHashUpdateHandlerSmoke } from "./features/l2ps/l2ps_hash_update_handler_smoke"
import { runL2psNodecallQueriesSmoke } from "./features/l2ps/l2ps_nodecall_queries_smoke"
import { runL2psLiveParticipationSmoke } from "./features/l2ps/l2ps_live_participation_smoke"
import { runL2psLiveSubmissionRelaySmoke } from "./features/l2ps/l2ps_live_submission_relay_smoke"
import { runGcrIdentitySmoke } from "./features/gcr/gcr_identity_smoke"
import { runGcrIdentityRemove } from "./features/gcr/gcr_identity_remove"
import { runGcrIdentityLoadgen } from "./features/gcr/gcr_identity_loadgen"
import { runGcrIdentityMatrix } from "./features/gcr/gcr_identity_matrix"
import { runGcrIdentityXmSmoke } from "./features/gcr/gcr_identity_xm_smoke"
import { runGcrPointsSmoke } from "./features/gcr/gcr_points_smoke"
import { runOmniConnectionSmoke } from "./features/omni/omni_connection_smoke"
import { runOmniMessageRoundtrip } from "./features/omni/omni_message_roundtrip"
import { runOmniReconnection } from "./features/omni/omni_reconnection"
import { runOmniThroughput } from "./features/omni/omni_throughput"
import { runConsensusBlockProduction } from "./features/consensus/consensus_block_production"
import { runConsensusTxInclusion } from "./features/consensus/consensus_tx_inclusion"
import { runConsensusSecretaryRotation } from "./features/consensus/consensus_secretary_rotation"
import { runConsensusRollbackSmoke } from "./features/consensus/consensus_rollback_smoke"
import { runConsensusPartitionRecovery } from "./features/consensus/consensus_partition_recovery"
import { runPetriBlockProduction } from "./features/consensus/petri_block_production"
import { runPetriTxInclusion } from "./features/consensus/petri_tx_inclusion"
import { runPetriRelayFlow } from "./features/consensus/petri_relay_flow"
import { runSyncCatchupSmoke } from "./features/peersync/sync_catchup_smoke"
import { runSyncConsistency } from "./features/peersync/sync_consistency"
import { runPeerDiscoverySmoke } from "./features/peersync/peer_discovery_smoke"
import { runSyncUnderLoad } from "./features/peersync/sync_under_load"
import { runZkCommitmentSmoke } from "./features/zk/zk_commitment_smoke"
import { runZkAttestationSmoke } from "./features/zk/zk_attestation_smoke"
import { runZkMerkleInclusion } from "./features/zk/zk_merkle_inclusion"
import { runZkProofLoadgen } from "./features/zk/zk_proof_loadgen"
import { runTlsNotaryRoutesSmoke } from "./features/tlsnotary/tlsnotary_routes_smoke"
import { runTlsNotaryVerifyRejects } from "./features/tlsnotary/tlsnotary_verify_rejects"
import { installGlobalFetchTimeout } from "./framework/common"
import { registerScenario, runScenario } from "./framework/scenario"

installGlobalFetchTimeout()

const scenario = (process.env.SCENARIO ?? "rpc").toLowerCase()

registerScenario("rpc", runRpcLoadgen)
registerScenario("rpc_ramp", runRpcRamp)
registerScenario("transfer", runTransferLoadgen)
registerScenario("transfer_ramp", runTransferRamp)
registerScenario("token_smoke", runTokenSmoke)
registerScenario("token_transfer", runTokenTransferLoadgen)
registerScenario("token_transfer_ramp", runTokenTransferRamp)
registerScenario("token_mint_smoke", runTokenMintSmoke)
registerScenario("token_burn_smoke", runTokenBurnSmoke)
registerScenario("token_mint", runTokenMintLoadgen)
registerScenario("token_burn", runTokenBurnLoadgen)
registerScenario("token_mint_ramp", runTokenMintRamp)
registerScenario("token_burn_ramp", runTokenBurnRamp)
registerScenario("token_acl_smoke", runTokenAclSmoke)
registerScenario("token_acl_matrix", runTokenAclMatrix)
registerScenario("token_consensus_consistency", runTokenConsensusConsistency)
registerScenario("token_query_coverage", runTokenQueryCoverage)
registerScenario("token_edge_cases", runTokenEdgeCases)
registerScenario("token_acl_burn_matrix", runTokenAclBurnMatrix)
registerScenario("token_acl_pause_matrix", runTokenAclPauseMatrix)
registerScenario("token_acl_transfer_ownership_matrix", runTokenAclTransferOwnershipMatrix)
registerScenario("token_acl_multi_permission_matrix", runTokenAclMultiPermissionMatrix)
registerScenario("token_acl_updateacl_compat", runTokenAclUpdateAclCompat)
registerScenario("token_script_smoke", runTokenScriptSmoke)
registerScenario("token_script_hooks_correctness", runTokenScriptHooksCorrectness)
registerScenario("token_script_rejects", runTokenScriptRejects)
registerScenario("token_script_upgrade_mid_load", runTokenScriptUpgradeMidLoad)
registerScenario("token_script_transfer", runTokenScriptTransferLoadgen)
registerScenario("token_script_transfer_ramp", runTokenScriptTransferRamp)
registerScenario("token_script_mint", runTokenScriptMintLoadgen)
registerScenario("token_script_mint_ramp", runTokenScriptMintRamp)
registerScenario("token_script_burn", runTokenScriptBurnLoadgen)
registerScenario("token_script_burn_ramp", runTokenScriptBurnRamp)
registerScenario("token_script_complex_policy_smoke", runTokenScriptComplexPolicySmoke)
registerScenario("token_script_complex_policy_ramp", runTokenScriptComplexPolicyRamp)
registerScenario("token_script_complex_policy_dynamic_updates", runTokenScriptComplexPolicyDynamicUpdates)
registerScenario("token_script_complex_policy_vesting_lockup", runTokenScriptComplexPolicyVestingLockup)
registerScenario("token_script_complex_policy_escrow_state_machine", runTokenScriptComplexPolicyEscrowStateMachine)
registerScenario("token_settle_check", runTokenSettleCheck)
registerScenario("token_observe", runTokenObserve)
registerScenario("token_invariants_known_holders", runTokenInvariantsKnownHolders)
registerScenario("token_pause_under_load", runTokenPauseUnderLoad)
registerScenario("token_holders_export", runTokenHoldersExport)
registerScenario("im_online", runImOnlineLoadgen)
registerScenario("im_online_ramp", runImOnlineRamp)
registerScenario("im_register_discover_smoke", runImRegisterDiscoverSmoke)
registerScenario("im_message_roundtrip", runImMessageRoundtrip)
registerScenario("fhe_scalar_smoke", runFheScalarSmoke)
registerScenario("fhe_arithmetic_smoke", runFheArithmeticSmoke)
registerScenario("web2_url_validation_smoke", runWeb2UrlValidationSmoke)
registerScenario("web2_sanitization_smoke", runWeb2SanitizationSmoke)
registerScenario("web2_dahr_rejects", runWeb2DahrRejects)
registerScenario("incentive_referral_code_smoke", runIncentiveReferralCodeSmoke)
registerScenario("incentive_referral_eligibility", runIncentiveReferralEligibility)
registerScenario("incentive_point_score_matrix", runIncentivePointScoreMatrix)
registerScenario("mcp_tool_factory_smoke", runMcpToolFactorySmoke)
registerScenario("mcp_server_registry_smoke", runMcpServerRegistrySmoke)
registerScenario("mcp_server_creation_smoke", runMcpServerCreationSmoke)
registerScenario("multichain_parser_rejects", runMultichainParserRejects)
registerScenario("multichain_parser_execute_smoke", runMultichainParserExecuteSmoke)
registerScenario("multichain_dispatcher_aggregation", runMultichainDispatcherAggregation)
registerScenario("l2ps_transaction_shape_smoke", runL2psTransactionShapeSmoke)
registerScenario("l2ps_service_status_smoke", runL2psServiceStatusSmoke)
registerScenario("l2ps_statistics_snapshot", runL2psStatisticsSnapshot)
registerScenario("l2ps_registry_state_smoke", runL2psRegistryStateSmoke)
registerScenario("l2ps_participant_cache_smoke", runL2psParticipantCacheSmoke)
registerScenario("l2ps_participant_discovery_resilience", runL2psParticipantDiscoveryResilience)
registerScenario("l2ps_incremental_sync_smoke", runL2psIncrementalSyncSmoke)
registerScenario("l2ps_exchange_participation_smoke", runL2psExchangeParticipationSmoke)
registerScenario("l2ps_consolidated_hash_smoke", runL2psConsolidatedHashSmoke)
registerScenario("l2ps_batch_grouping_smoke", runL2psBatchGroupingSmoke)
registerScenario("l2ps_batch_payload_smoke", runL2psBatchPayloadSmoke)
registerScenario("l2ps_hash_service_cycle_smoke", runL2psHashServiceCycleSmoke)
registerScenario("l2ps_batch_nonce_progression_smoke", runL2psBatchNonceProgressionSmoke)
registerScenario("l2ps_batch_submission_smoke", runL2psBatchSubmissionSmoke)
registerScenario("l2ps_batch_submission_zk_rejects", runL2psBatchSubmissionZkRejects)
registerScenario("l2ps_process_batch_for_uid_smoke", runL2psProcessBatchForUidSmoke)
registerScenario("l2ps_hash_process_network_smoke", runL2psHashProcessNetworkSmoke)
registerScenario("l2ps_hashes_store_smoke", runL2psHashesStoreSmoke)
registerScenario("l2ps_hash_update_handler_smoke", runL2psHashUpdateHandlerSmoke)
registerScenario("l2ps_nodecall_queries_smoke", runL2psNodecallQueriesSmoke)
registerScenario("l2ps_live_participation_smoke", runL2psLiveParticipationSmoke)
registerScenario("l2ps_live_submission_relay_smoke", runL2psLiveSubmissionRelaySmoke)
registerScenario("gcr_identity_smoke", runGcrIdentitySmoke)
registerScenario("gcr_identity_remove", runGcrIdentityRemove)
registerScenario("gcr_identity_loadgen", runGcrIdentityLoadgen)
registerScenario("gcr_identity_matrix", runGcrIdentityMatrix)
registerScenario("gcr_identity_xm_smoke", runGcrIdentityXmSmoke)
registerScenario("gcr_points_smoke", runGcrPointsSmoke)
registerScenario("omni_connection_smoke", runOmniConnectionSmoke)
registerScenario("omni_message_roundtrip", runOmniMessageRoundtrip)
registerScenario("omni_reconnection", runOmniReconnection)
registerScenario("omni_throughput", runOmniThroughput)
registerScenario("consensus_block_production", runConsensusBlockProduction)
registerScenario("consensus_tx_inclusion", runConsensusTxInclusion)
registerScenario("consensus_secretary_rotation", runConsensusSecretaryRotation)
registerScenario("consensus_rollback_smoke", runConsensusRollbackSmoke)
registerScenario("consensus_partition_recovery", runConsensusPartitionRecovery)
registerScenario("petri_block_production", runPetriBlockProduction)
registerScenario("petri_tx_inclusion", runPetriTxInclusion)
registerScenario("petri_relay_flow", runPetriRelayFlow)
registerScenario("sync_catchup_smoke", runSyncCatchupSmoke)
registerScenario("sync_consistency", runSyncConsistency)
registerScenario("peer_discovery_smoke", runPeerDiscoverySmoke)
registerScenario("sync_under_load", runSyncUnderLoad)
registerScenario("zk_commitment_smoke", runZkCommitmentSmoke)
registerScenario("zk_attestation_smoke", runZkAttestationSmoke)
registerScenario("zk_merkle_inclusion", runZkMerkleInclusion)
registerScenario("zk_proof_loadgen", runZkProofLoadgen)
registerScenario("tlsnotary_routes_smoke", runTlsNotaryRoutesSmoke)
registerScenario("tlsnotary_verify_rejects", runTlsNotaryVerifyRejects)
await runScenario(scenario)
