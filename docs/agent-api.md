# ReliaCode Agent API v1.1

The Agent API is vendor-neutral HTTPS JSON. Any automation agent that knows an
authorized ReliaCode username and password can discover the contract, obtain a
short-lived token, and generate codes within that account's existing role and
brand boundary.

The same token can also inspect the account's authorized products, codes,
packaging relationships, shipments, alerts, operation logs, distributors,
users, factories, and statistics. Call `GET /api/agent/capabilities` first to
obtain the exact capability list for the authenticated role.

## Discovery

`GET /.well-known/reliacode-agent.json`

The discovery document is public and contains no tenant data or credentials.

## Authenticate

`POST /api/agent/login`

```json
{
  "username": "account-name",
  "password": "account-password",
  "client_name": "agent-name"
}
```

The response returns a Bearer token valid for one hour. Tokens are shown once,
stored only as an HMAC digest, rate-limited at login, bound to one user, and
immediately invalid when the user or tenant is disabled. Only `admin`, `brand`,
and `brand_staff` accounts can receive a code-generation token.

## Generate codes

Every generation request requires both headers:

```text
Authorization: Bearer rca_...
Idempotency-Key: a-unique-value-for-this-logical-request
```

Generate item codes:

`POST /api/agent/codes/items`

```json
{
  "product_id": 123,
  "batch_no": "BATCH-2026-001",
  "item_count": 100
}
```

Generate box codes:

`POST /api/agent/codes/boxes`

```json
{
  "product_id": 123,
  "batch_no": "BATCH-2026-001",
  "box_count": 10
}
```

Retry the exact same logical request with the same `Idempotency-Key`. ReliaCode
returns the original response and does not create a second set of codes. Reusing
the key with a different body returns `409 IDEMPOTENCY_CONFLICT`.

## Inspect and revoke

- `GET /api/agent/capabilities` returns the role-specific read and mutation list.
- `GET /api/agent/me` returns the authenticated identity and scope.
- `POST /api/agent/logout` immediately revokes the current token.

Read-only domain endpoints advertised by the capability response accept the
same Bearer token. Existing browser mutation endpoints are intentionally not
opened automatically: Agent writes use explicit `/api/agent/...` commands and
an `Idempotency-Key`, preventing a leaked token from silently gaining every
destructive administration action.

Do not place passwords or tokens in URLs, logs, prompts, source repositories, or
long-lived configuration files. An Agent should authenticate just before work,
keep the token in memory, submit an idempotency key for every write, and revoke
the token when finished.
