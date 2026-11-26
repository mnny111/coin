# Coin

An independent implementation of the Coin concept supplied in the conversation. No pairedcoin.family scraping or copied private backend. Includes a simple white frontend with ecosystem search, paired-coin buybacks and burns, transaction activity, launch instructions, and FAQs.

The frontend is served by the same Node server at `/`, `/buybacks` (legacy `/rewards` remains available), `/activity`, and `/about`. It reads the real backend APIs, refreshes every 30 seconds while visible, and leaves unconfigured values unavailable. It contains no seeded coins or invented transactions. Launching continues on Pump.fun; this site does not request wallet connections. Desktop and 390px mobile layouts, navigation, search empty state, launch dialog and FAQ were checked in the browser with no console errors.

## Implemented behavior

- Discovers Pump launches quoted in your `COIN_MINT`, without developer registration or a website wallet connection.
- Indexes finalized Pump bonding-curve and canonical PumpSwap trades. Rankings use raw Coin quote-token volume, with buys and sells counted once per event.
- Collects SOL creator fees from the main Coin's Pump and PumpSwap vaults, including sweeping current curve/pool fee buckets.
- Allocates collected fees: **70% buyback/burn, 30% paired-coin buybacks and burns, no treasury allocation**. Amounts use integers, never floating-point token arithmetic.
- Buys main Coin on its SOL curve or canonical SOL pool, then burns the exact purchased quantity in the **same atomic transaction**. Slippage and spend caps apply.
- Every three hours, allocates the 30% pool across all paired coins with nonzero round volume, proportional to their volume. Older pairs qualify; the service wallet’s trades do not count.
- Each allocation first buys Coin with SOL. Once finalized, a durable second job buys the paired token and burns the exact purchased quantity atomically. Both steps have separate receipts. No SOL transfers to developers remain.
- Unspent SOL returns to a later round. Unspent Coin is recorded as a per-pair credit and reused on that pair’s next funding confirmation. Failed or dust-sized purchases retain their reservations and require operator retry; they never count as completed burns.
- Persists receipts, indexing cursors, rounds, reservations, signed transaction bytes, and execution state in SQLite WAL.
- Reconciles finalized signatures before reporting success. A timeout rebroadcasts the same signed bytes; it does not create a second purchase.
- Provides public JSON endpoints for a future frontend, with Solscan links for submitted transactions. Admin endpoints require a bearer token.

The SOL → Coin → paired-token trading route belongs to Pump's launch/trading protocol. This backend does not intercept swaps or make arbitrary tokens eligible for quoting; the main coin must meet Pump's current quote-token requirements. Users launch on Pump.fun and select Coin there.

## Explicit assumptions

The user-selected fee split is 70% buyback/burn and 30% paired-coin buybacks and burns. The remaining rules below are implementation defaults, not claims about the reference service:

| Rule | Default |
| --- | --- |
| Treasury | No allocation; rounding remainder goes to paired-coin buybacks and burns |
| Round boundaries | UTC 00:00–03:00, 03:00–06:00, etc. |
| Pair eligibility | All discovered pairs with nonzero round volume, regardless of launch date |
| Ranking | Coin quote-token volume across the Pump curve and canonical PumpSwap pool |
| Pair allocation | Proportional to round volume, using exact integers; deterministic rounding |
| No volume | Carry funds forward |
| Multiple coins by one creator | Each coin eligible independently |
| Purchase target | Verified paired mint; never a creator payout address |
| Ties | Earlier creation time, then ascending mint address |
| Fee timing | A round uses fee receipts collected before its end; later collections fund later rounds |
| Safety delay | 120 seconds after a round ends, plus completed finalized indexing |

`PAIR_BUYBACK_BPS`, main buyback basis points, round duration, and trading limits are configurable. Core accounting policy is bound to the database on first configured use. Changing the mint, creator, start time, percentages or pair allocation policy after that requires a reviewed migration or a fresh database; silently reinterpreting old money is rejected.

Trading-volume ranking is susceptible to wash trading. No Sybil or wash-trade classifier is claimed. A large volume score is not a quality guarantee.

## Run locally

Requires Node.js 24 or later.

```powershell
npm ci --ignore-scripts
Copy-Item .env.example .env
npm start
```

The API starts at `http://127.0.0.1:3000` with empty data. `/health` explicitly reports that it is unconfigured. It never inserts demonstration trades or fake burns.

Configure these four values in `.env` to start real read-only indexing:

```dotenv
EXECUTION_MODE=observe
SOLANA_RPC_URL=https://YOUR_ARCHIVAL_SOLANA_RPC
COIN_MINT=YOUR_MAIN_COIN_ADDRESS
CREATOR_ADDRESS=YOUR_DEDICATED_CREATOR_WALLET
START_TIME=UNIX_SECONDS_AT_OR_BEFORE_YOUR_MAIN_COIN_LAUNCH
```

Then run the worker in a second terminal:

```powershell
npm run worker
```

Or run both processes under one supervisor:

```powershell
npm run service
```

Observation mode indexes and calculates rounds/jobs but **never reads a signing key, signs, or broadcasts**. Proposed jobs remain `planned`; they are not completed burns. When switching to live mode, previously planned buybacks are still obligations and will execute. Review the observed rounds before that switch.

The RPC needs full transaction history from `START_TIME`, version-0 transaction support, inner instructions, and finalized block times. Missing transaction bodies stop cursor advancement and settlement. A provider that silently omits historical signatures can produce an incomplete index; use a trusted archival RPC. The polling indexer is intended for an initial deployment; throughput for thousands of active pairs has not been load-tested. A production deployment at that scale should use a durable Geyser/indexing feed and retain the same ledger contracts.

## Enable live execution

Create your own main Coin paired with SOL, using a **dedicated creator wallet**. Pump's creator vaults aggregate fees from every coin using a creator address; the backend cannot attribute a collection to one mint when that wallet is reused. Shared creator-fee configurations, CTO destinations that differ from the configured creator, non-SOL main-coin quotes, and transfer-fee main mints are rejected or unsupported.

Provide a local 64-byte Solana JSON keypair file through a secret mount, not the repository. Fund this wallet separately for transaction fees and token-account rent. Then set:

```dotenv
EXECUTION_MODE=live
SIGNER_KEY_FILE=/run/secrets/coin-creator.json
DEDICATED_CREATOR_CONFIRMED=true
```

The signer must match `CREATOR_ADDRESS`. Defaults reserve 0.05 SOL for gas, collect at five-minute intervals when at least 0.01 SOL is available, and cap each main buyback or pair-funding transaction at 0.1 SOL. Buyback quotes allow 1% slippage inside that budget. Network fees and operating costs require separate funding. The `treasury` API field remains for compatibility and is zero under the 70/30 policy. Donations/top-ups are not automatically treated as creator fees or pair-pot deposits.

No mainnet transaction has been submitted or verified end to end for this deliverable. Before running live, perform funded validation with your own token and small limits: collection, atomic buy-and-burn, and the two-stage paired purchase/burn. Never use the reference project's mint or wallets as your deployment settings.

The accounting policy now includes `all-volume-v1`. Existing configured reward databases are deliberately rejected; they require an explicit migration rather than silently converting old payout obligations. Internal `rewards`/`availableRewards` fields retain their names for schema compatibility but represent the 30% pair-buyback pool. `pairFunded` reports SOL converted to Coin, not completed paired burns; `pairBurns` counts confirmed burn jobs. `pairQuoteCredits` lists carried Coin balances by target mint.

## API contract

All money/token amounts are decimal **strings in base units**. SOL amounts are lamports. A `pair_burn` job’s amount is Coin base units; `details.burned` is the target mint’s base units with `details.decimals` and `details.mint`. Trading volume is Coin base units. Timestamps are Unix seconds.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health` | API availability, configuration, worker heartbeat, execution mode |
| GET | `/api/config` | Public addresses, percentages, round rules and Pump launch URL |
| GET | `/api/stats` | Collected/allocated fees, available reservations, confirmed burns and pair funding, pair count |
| GET | `/api/pairs` | Discovered launches; `limit` and `offset` supported |
| GET | `/api/rounds/current` | Current boundaries, available pot, provisional leaderboard, index watermark |
| GET | `/api/rounds` | Immutable historical pair allocation snapshots |
| GET | `/api/transactions` | Jobs and statuses, signatures, explorer links; no signed transaction bytes |
| GET | `/api/fees` | Deduplicated collection receipts and explorer links |
| GET | `/admin/status` | Authenticated worker error and pending job information |
| POST | `/admin/pause` | `{"paused":true}` stops new executions; indexing and in-flight reconciliation continue |
| POST | `/admin/retry` | `{"id":"pair:..."}` retries reserved failed jobs (preparation or finalized execution failures) |

Admin requests require `Authorization: Bearer <ADMIN_TOKEN>` with an operator-supplied token of at least 32 characters. Without a token, all admin requests are denied. Use TLS and a reverse proxy with rate limiting if exposing the API outside localhost. No browser cross-origin permission is enabled by default; serve the later frontend behind the same origin.

Jobs progress `planned → prepared → confirmed` or `prepared → failed`. `prepared` means signed and possibly broadcast, not success. Known finalized failures retain their allocation and require explicit retry. Preparation errors become failed with their allocation reserved, so one unsupported or illiquid pair cannot block the rest; use the retry endpoint after resolving the cause. Expired signatures are rebuilt only after finalized expiry and a second signature-history check. The transaction audit retains replaced signatures.

## Deploy

For Docker, configure `.env` then use `docker compose up --build -d`. Both containers mount the same local named volume. Add a read-only signing-key secret mount to the worker for live mode. Docker installation uses `--ignore-scripts` intentionally.

For Railway or another container host, deploy **one service replica** with a persistent volume mounted at `/app/data`, start command `node src/service.js`, `HOST=0.0.0.0`, and `DATABASE_PATH=/app/data/coin.sqlite`. Set runtime variables from `.env.example` and mount the keypair file securely. Two separate Railway services cannot share a local SQLite volume; use this combined service or migrate storage to Postgres before separating them. No hosting deployment or account changes were made here.

Back up the SQLite database with a SQLite-aware backup tool, or stop both processes before copying the database and its WAL files. Do not replace the database on a live worker: its transaction journal is what prevents repeat purchases.

## Validation and dependency notes

`npm test`: 45 passing tests after the nested listing change. Tests cover integer conservation, ranking and eligibility, rollovers, fee timing, duplicate events, persisted state, transaction timeout/expiry/failure recovery, real HTTP endpoints, SDK event decoding, real Solana transaction construction with mocked RPC simulation, and JSON-RPC transport compatibility. `npm run check` passes.

These are local/fixture tests. They do not prove that current mainnet conditions, account state, fee collection, or buybacks will succeed with your token. No funded mainnet or local-validator end-to-end run was performed.

Pump SDKs are pinned to `@pump-fun/pump-sdk@4.3.1` and `@pump-fun/pump-swap-sdk@2.2.0`. Patched `jayson@5.0.0` and `toml@5.0.1` overrides remove their inherited advisories; a real HTTP fixture verifies the replaced RPC transport. The remaining npm audit findings trace to `bigint-buffer@1.1.5` and its SDK dependency chain (six high-severity package entries). The vulnerable native binding is not built with the documented `--ignore-scripts` installation; this installation uses its JavaScript fallback. Do not run `npm rebuild` to enable that binding. The audit findings remain unresolved upstream; do not interpret this as a clean security audit.

Official integration references:

- https://github.com/pump-fun/pump-public-docs
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md
- Installed SDK source and type declarations under `node_modules/@pump-fun/`

## Source layout

`src/config.js` validates runtime configuration. `src/store.js` owns persistence and worker leases. `src/engine.js` owns deterministic money and round rules. `src/chain.js` handles official SDK instructions and finalized event indexing. `src/worker.js` handles scheduling and the durable transaction queue. `src/server.js` exposes JSON APIs. `src/service.js` runs both processes on one persistent disk.

## Nested-pair listing

Coins paired with a direct Coin pair are discovered privately. Set `NESTED_FEE_WALLET` to the chosen public receiving address. With no wallet configured, no nested coin is listed. A nested listing requires both a current canonical Pump fee-sharing configuration allocating 100% to that wallet and at least one positive, finalized Pump creator-fee distribution identifying that mint, its parent quote token, and that recipient. Ordinary token transfers and partial shares do not qualify.

The worker validates the sharing account owner, mint, curve creator/quote, and migrated pool creator/quote at finalized commitment. Changed, failed, or more-than-five-minute-old verification hides the nested listing. Funds arrive in the parent token, remain separate from the SOL buyback ledger, and are not automatically spent by this listing integration. Direct-pair listings and buyback eligibility are unchanged; nested tokens are displayed only, not added to direct-pair volume rankings. This gates the website listing, not permissionless Pump launches.
