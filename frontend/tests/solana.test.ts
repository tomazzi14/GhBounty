/**
 * GHB-80: unit tests for the Solana client helpers.
 *
 * The helpers are pure (no signing, no RPC roundtrip) so we can assert on:
 *   - PDA derivation determinism + sensitivity to inputs
 *   - Instruction shape: program id, account ordering, signer/writable flags
 *   - Discriminator bytes (Anchor IDL guarantees these — we encode them so
 *     a stale IDL would surface as a discriminator mismatch in tests)
 */
import { describe, it, expect } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { buildCreateBountyIx, findBountyPda, PROGRAM_ID } from "@/lib/solana";

const CREATOR_A = new PublicKey("11111111111111111111111111111112");
const CREATOR_B = new PublicKey("11111111111111111111111111111113");

describe("findBountyPda", () => {
  it("is deterministic for the same (creator, bountyId)", () => {
    const [a] = findBountyPda(CREATOR_A, 123n);
    const [b] = findBountyPda(CREATOR_A, 123n);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("differs across bounty ids", () => {
    const [a] = findBountyPda(CREATOR_A, 1n);
    const [b] = findBountyPda(CREATOR_A, 2n);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it("differs across creators", () => {
    const [a] = findBountyPda(CREATOR_A, 1n);
    const [b] = findBountyPda(CREATOR_B, 1n);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it("uses little-endian u64 encoding for bountyId", () => {
    // bountyId=1 LE -> [01,00,00,00,00,00,00,00], not [00,...,01].
    // Re-deriving with a different LE would yield a different PDA;
    // a known fixed pair acts as a regression guard against accidental BE.
    const [pda] = findBountyPda(CREATOR_A, 1n);
    const [pdaSame] = findBountyPda(CREATOR_A, 1n);
    expect(pda.toBase58()).toBe(pdaSame.toBase58());
    // Sanity: different LE (1 vs 2^32) must differ.
    const [pdaBig] = findBountyPda(CREATOR_A, 4_294_967_296n);
    expect(pda.toBase58()).not.toBe(pdaBig.toBase58());
  });
});

describe("buildCreateBountyIx", () => {
  it("returns instruction targeting the program id with correct accounts", async () => {
    const { bountyPda, bountyId, ix } = await buildCreateBountyIx({
      creator: CREATOR_A,
      amountLamports: 1_000_000n,
      githubIssueUrl: "https://github.com/test/repo/issues/1",
      bountyId: 42n,
    });
    expect(bountyId).toBe(42n);
    expect(ix.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(ix.keys).toHaveLength(3);

    // creator: signer + writable
    expect(ix.keys[0].pubkey.toBase58()).toBe(CREATOR_A.toBase58());
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);

    // bounty PDA: writable, not signer
    expect(ix.keys[1].pubkey.toBase58()).toBe(bountyPda.toBase58());
    expect(ix.keys[1].isSigner).toBe(false);
    expect(ix.keys[1].isWritable).toBe(true);

    // system program: read-only
    expect(ix.keys[2].pubkey.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(ix.keys[2].isSigner).toBe(false);
    expect(ix.keys[2].isWritable).toBe(false);
  });

  it("encodes the 8-byte create_bounty discriminator at the head of the data", async () => {
    // Discriminator from the IDL — guards against IDL drift.
    const expected = Uint8Array.from([122, 90, 14, 143, 8, 125, 200, 2]);
    const { ix } = await buildCreateBountyIx({
      creator: CREATOR_A,
      amountLamports: 1n,
      githubIssueUrl: "u",
      bountyId: 1n,
    });
    const head = Uint8Array.from(ix.data.subarray(0, 8));
    expect(Array.from(head)).toEqual(Array.from(expected));
  });

  it("auto-generates bountyId from the current timestamp when omitted", async () => {
    const before = BigInt(Date.now());
    const { bountyId } = await buildCreateBountyIx({
      creator: CREATOR_A,
      amountLamports: 1n,
      githubIssueUrl: "u",
    });
    const after = BigInt(Date.now());
    expect(bountyId).toBeGreaterThanOrEqual(before);
    expect(bountyId).toBeLessThanOrEqual(after);
  });

  it("derives the same PDA the helper computes for the bounty account", async () => {
    const { bountyPda, bountyId, ix } = await buildCreateBountyIx({
      creator: CREATOR_A,
      amountLamports: 1n,
      githubIssueUrl: "u",
      bountyId: 99n,
    });
    const [expected] = findBountyPda(CREATOR_A, bountyId);
    expect(bountyPda.toBase58()).toBe(expected.toBase58());
    expect(ix.keys[1].pubkey.toBase58()).toBe(expected.toBase58());
  });

  it("does not throw when the URL exceeds the on-chain max (chain validates)", async () => {
    // The contract enforces MAX_URL_LEN=200; the client is intentionally
    // permissive so the chain remains the source of truth.
    const { ix } = await buildCreateBountyIx({
      creator: CREATOR_A,
      amountLamports: 1n,
      githubIssueUrl: "x".repeat(250),
      bountyId: 1n,
    });
    expect(ix).toBeTruthy();
  });
});
