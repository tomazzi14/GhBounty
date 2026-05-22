# Ghbounty

> Automated GitHub bounty marketplace with AI-verified PRs. Opus analyzes, GenLayer juries on-chain, humans pick the winner. Solana-first, agent-native via x402 + MCP.

## What it is

Ghbounty is a bounty platform for GitHub issues where **companies post bounties, developers (human or AI) submit PRs, and an automated evaluation pipeline decides the ranking**. Final winner selection is always human.

The core loop:

1. **Developer** submits a PR against a bounty.
2. **Pre-processor** filters the diff (lockfiles, binaries, generated configs).
3. **Sandbox** (Fly.io) clones the repo, applies the PR, runs the test suite.
4. **Claude Opus** analyzes everything with 200K context, generates a structured report (Code Quality, Test Coverage, Requirements, Security).
5. **GenLayer** scores each dimension on-chain: 5 validators × 5 exec_prompts = 25 independent evaluations under `strict_eq` consensus.
6. **Company** reads only the top-scored PRs (reject threshold filters noise automatically), picks **one** winner, escrow releases the payment.

## Quick Start

1. **Prerequisites**
   - [Node 24+](https://nodejs.org/)
   - [pnpm 10+](https://pnpm.io/installation)
   - [Solana CLI](https://docs.solana.com/cli/install)

2. **Install and run**
   ```bash
   pnpm install
   cp frontend/.env.example frontend/.env.local
   pnpm dev
   ```
   Run `pnpm dev` from the `/frontend` directory.

## Why hybrid (Opus + GenLayer)

GenLayer has a practical ~256-token output ceiling per `exec_prompt`. Asking it to read a full 10K-token PR and emit a verdict is not feasible. So:

- **Opus (off-chain)** does the deep reasoning with long context and produces a compact report.
- **GenLayer (on-chain)** judges each section of the report on a single dimension with a short structured output — exactly what `strict_eq` consensus needs.

Result: descentralized AI jury + reproducible scores + full auditability.

## Status

MVP in progress. Current focus: Phase 1 (Core MVP on Solana).

- [ ] GenLayer multi-call rewrite (INFRA-1, unblocks everything)
- [ ] Solana Anchor escrow program
- [ ] Relayer (Node.js, Railway)
- [ ] Postgres schema + chain registry
- [ ] Dashboards (Next.js + Vercel)
- [ ] Sandbox (Fly.io ephemeral machines)
- [ ] Agents: x402 + MCP server + agent wallets
- [ ] Base as second chain (Phase 2)

## Stack

- **Frontend:** Next.js + Vercel, RainbowKit (EVM) + wallet-adapter (Solana)
- **Backend:** Express + x402 middleware on Railway, MCP server (TypeScript SDK)
- **Data:** Postgres (Neon), R2 (Cloudflare), Claude Opus API
- **On-chain:** Anchor program (Solana MVP), `BountyEscrow.sol` (Base, Phase 2), GenLayer for the jury
- **Sandbox:** Fly.io ephemeral machines (5 min timeout, destroyed after each run)

## Architecture at a glance

Chain-agnostic by design. A `chain_registry` table in Postgres lists every supported chain; adding a chain = inserting a row + deploying the contract. Zero code changes.

The relayer is the only component aware of multiple chains. For EVM it uses `viem` WebSockets; for Solana `@solana/web3.js` with `onAccountChange`. When it detects a `SubmissionCreated`, it runs the pipeline (sandbox → Opus → GenLayer) and calls the escrow on the originating chain to release funds once the company approves a winner.

## Repository layout

```
ghbounty/
├── contracts/
│   ├── genlayer/       # BountyJudge.py (multi-call, strict_eq consensus)
│   └── solana/         # Anchor program (escrow)
├── tests/
│   └── genlayer/       # Local simulator tests
├── relayer/            # Node.js event listener (Railway)
├── backend/            # Express + x402 + MCP server
└── frontend/           # Next.js app
```

Directories are added as each phase lands.

### Stake authority keypair (MCP Phase 0)

Each developer must generate their own dev keypair for the stake authority:

```bash
mkdir -p contracts/solana/keys
solana-keygen new --no-bip39-passphrase --silent \
  --outfile contracts/solana/keys/stake-authority-dev.json
solana-keygen pubkey contracts/solana/keys/stake-authority-dev.json
```

The pubkey is hardcoded in `contracts/solana/programs/ghbounty_escrow/src/constants.rs` as `STAKE_AUTHORITY_PUBKEY`. The keypair is loaded by the relayer via `STAKE_AUTHORITY_KEYPAIR_JSON` env var (see `relayer/.env.example`).

For mainnet rotation, see [GHB-179](https://linear.app/ghbounty/issue/GHB-179).

## Database migrations

**Schema changes go through Drizzle migrations — NEVER via direct paste in Supabase Studio.** Migrations live in `packages/db/drizzle/*.sql`, are committed to git, and are tracked in `packages/db/drizzle/meta/_journal.json`. Every schema change is auditable in git history and replayable across environments.

### Workflow

1. Edit `packages/db/src/schema.ts` (the Drizzle TypeScript schema).
2. Generate the migration SQL:
   ```bash
   pnpm db:generate
   ```
   Drizzle Kit diffs your TS schema against the last snapshot, writes a new `NNNN_<slug>.sql` in `packages/db/drizzle/`, and updates `meta/_journal.json`. Review the SQL — if it doesn't match your intent, edit the schema and regenerate.
3. Apply the migration to devnet:
   ```bash
   pnpm db:migrate
   ```
   Drizzle Kit applies any pending migrations in order, tracked in the DB's `__drizzle_migrations` table.
4. Commit the SQL file, the updated `_journal.json`, and any new `*_snapshot.json` in `meta/`.
5. The same `pnpm db:migrate` is what runs against prod when ready — no copy-paste, no drift between environments.

### Configuration

`pnpm db:migrate` needs `DATABASE_URL` pointing to the target Postgres. Local setup:

```bash
cp packages/db/.env.example packages/db/.env.local
# Edit packages/db/.env.local — fill DATABASE_URL with the Supabase URI
# (Project Settings → Database → Connection string → URI). Use the Session
# pooler (port 5432), NOT the Transaction pooler (port 6543) — migrations
# need multi-statement BEGIN/COMMIT blocks.
```

`.env.local` is gitignored. Never commit a real `DATABASE_URL`.

### Rules

- **Always use migrations** for schema changes (tables, columns, FKs, RLS policies, indexes). Never `CREATE TABLE` directly in Supabase Studio.
- **Use Supabase Studio SQL Editor only** for ad-hoc data ops (debug queries, `TRUNCATE` of devnet test data, manual fixes) — never for structural changes.
- **CI / Vercel never run migrations.** Migrations are applied manually by a human against the target environment. This is a deliberate human-approval gate for destructive operations.

## License

MIT — see [LICENSE](LICENSE).
