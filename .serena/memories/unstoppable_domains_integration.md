# Unstoppable Domains Identity Integration

## Overview
Integration of Unstoppable Domains (UD) as an identity type in the Demos Network identity system.

## Current Context
- **Branch**: `ud_identities`
- **Location**: Identity system implemented in `src/libs/abstraction/`
- **Note**: This is NOT the Demos public key identity, but the linked identities system

## Existing Identity Types
Users currently have:
- GitHub integration
- Discord integration
- Twitter integration
- Web3 integration

## New Requirement: Unstoppable Domains
Add UD as an additional identity type alongside existing integrations.

## Strategic Rationale
- UD will soon support `.demos` addresses (not yet available)
- Implementing now to have the system ready when UD launches `.demos` support
- Proactive preparation for future capability

## Technical Approach
Following the **web3 approach** as defined in Unstoppable Domains documentation:
- **Reference**: https://docs.unstoppabledomains.com/smart-contracts/quick-start/resolve-domains/
- Implementation will follow smart contract-based domain resolution patterns

## Development Plan - Phase 1: Exploration

### Step 1: Local Testing Environment
**Action**: Create gitignored local testing workspace
- **Location**: `local_tests/` (add to `.gitignore`)
- **Purpose**: Isolated environment for UD domain resolution experiments

### Step 2: TypeScript Resolution Testing
**Action**: Create standalone TypeScript files to test UD domain resolution
- Test domain resolution mechanisms
- Understand UD API/SDK patterns
- Validate web3 approach from UD documentation
- Document findings for integration into main codebase

### Next Phases (TBD)
1. Integration with existing identity abstraction system
2. API/SDK selection and setup
3. Identity type implementation
4. Testing and validation
5. Documentation

## Key Constraints
- Must integrate with existing `src/libs/abstraction/` identity system
- Follow established patterns for GitHub, Discord, Twitter, Web3 integrations
- Prepare for future `.demos` address support
- Use web3 smart contract approach per UD documentation

## Implementation Status
- [x] Requirements documented
- [ ] Local testing environment created
- [ ] Domain resolution proof-of-concept
- [ ] Integration design
- [ ] Implementation
- [ ] Testing
- [ ] Documentation
