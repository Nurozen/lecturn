# Generated extension contract catalog

The public contracts in `packages/contracts` define the boundary for separately built extension helpers and evaluators. `scripts/generate-extension-contracts.ts --out-dir <empty-directory>` generates deterministic JSON Schema, OpenAPI, RPC operation metadata, runtime constraints, and conformance examples. No generated catalog is checked in.

`operations.json` separates mounted `rpc` methods from `declaredRpc` contracts that are not yet mounted. The OpenAPI document reflects the current `RelayApi`; HTTP coverage gaps remain explicit. A declared contract does not activate collection, funding, inference, or a server endpoint. JSON Schema does not preserve Effect runtime predicates, authorization, or revision fences; consumers must implement the accompanying runtime constraints and execute conformance cases.

The manifest records the source commit, dirty state, source digests, and every artifact checksum. Consumers pin the manifest SHA-256 and authenticate the complete archive before generating validators. Regenerate and publish a new catalog when consumed schemas change. Local dirty catalogs are suitable only for development.

The `Generated extension contract catalog` workflow checks schemas and deterministic output on pull requests. Publication is an explicit default-branch dispatch with `publish=true`, gated by the `extension-contract-publication` environment. Configure required reviewers, restrict the environment to the default branch, and set `EXTENSIONS_CONTRACT_PUBLICATION_TOKEN` with Contents write and Administration read on this public repository. The workflow requires immutable releases and publishes a digest-named release once, with no asset replacement.

Repository-wide immutable releases also affect desktop releases. Their workflow stages both stable and nightly assets in a draft and publishes after every asset upload succeeds. Published releases cannot be repaired by replacing binaries; corrections require a new release version.
