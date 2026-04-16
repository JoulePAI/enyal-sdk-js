# Changelog

## v2.1.0 (2026-04-16)

### Added
- Retry wrapper with deterministic idempotency keys on all 9 state-changing endpoints
- idempotencyKey parameter on archive, prove, disclose, timestamp, createAgreement, complianceAttest, sendMessage, requestClientDisclosure, requestShareProof
- synthesiseKnowledge throws clear session-auth error (endpoint requires web console)
- Exponential backoff with jitter, Retry-After header support

### Changed
- Dual-package: ESM source + CJS build via esbuild (Node 18+ compatible)
- All 23 fetch() calls refactored through shared _apiCall() helper
- Package published as @enyalai/sdk on npm

### Fixed
- Node 18-19 compatibility (was broken due to ESM syntax in CJS package)
- ESM/CJS dual-package verified on Node 18 and Node 20 via Docker 4-matrix

## v2.0.0 (2026-04-09)

Initial release: encrypted knowledge graph, local memory, permanent proof.
