# ReliaCode

穿山甲溯源大师，作为部分门店（宠物行业）在溯源码过程中的 AI 化提升方案。

ReliaCode (可靠码) is an operator-managed traceability application for serialized pet-food packs.
It records the lifecycle from individual bag to carton, distributor, and retail store.

## Scope

- Assign a unique identity to each finished bag.
- Bind bags to a uniquely identified carton at packing time.
- Record shipping, receiving, unpacking, repacking, returns, and recall events.
- Let ReliaCode configure auditable incentives for verified distributor and store
  activities.
- Publish GS1 EPCIS 2.0 events to an OpenEPCIS repository.

ReliaCode is the business and scan-workflow layer. OpenEPCIS is the standards-based
traceability event repository; it is an external dependency, not vendored source code.

## Architecture

```text
Scan stations / mobile app -> ReliaCode API -> OpenEPCIS -> trace and recall views
                                      |
                                      +-> ERP/WMS adapter
```

See [the architecture note](docs/architecture.md) and
[ADR-0001](docs/adr/0001-openepcis-as-traceability-core.md).
The initial incentive design is documented in
[scan-incentive.md](docs/domain/scan-incentive.md).
For industry review, see the Chinese [usage and reward model](docs/zh-CN/可靠码使用与奖励模式-行业评审稿.md).

## First acceptance scenario

1. Commission 100 serialized bags in one production lot.
2. Pack ten bags into each uniquely identified carton.
3. Ship and receive cartons at a distributor, then at a store.
4. Unpack, repack, sell, and return bags.
5. Trace from an ingredient/production lot to every affected bag and its latest custodian.

## License and notices

ReliaCode-owned files are licensed under [Apache-2.0](LICENSE). OpenEPCIS is a
separate Apache-2.0 dependency. See [third-party notices](THIRD_PARTY_NOTICES.md).

This repository contains a production-oriented API baseline and a browser-based
operations prototype. It contains no production credentials or customer data.
The API uses PostgreSQL transactions, OIDC identities, tenant-scoped RBAC,
idempotent commands, append-only trace/ledger/audit records, and an outbox for
OpenEPCIS delivery. See [production readiness](docs/production-readiness.md) and
the [operations runbook](docs/operations-runbook.md) before any deployment.

## Runnable MVP

The standalone browser workspace is in [apps/scan-web](apps/scan-web). Run
`npm run dev` from that folder and open `http://localhost:4173`, or use the
[GitHub Pages build](https://nsieteam.github.io/ReliaCode/). It ships with no
brand, product, code, event, campaign, reward, risk, or account records. The
first user creates an empty workspace and can export/import a JSON backup file.

The browser-local workspace is not the production data source. Production writes
must use [apps/scan-api](apps/scan-api); local identity switching and data reset
must be disabled when the OIDC-backed frontend integration is enabled.
