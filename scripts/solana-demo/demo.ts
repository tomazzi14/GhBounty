/**
 * End-to-end demo of the ghbounty_escrow program against Solana devnet.
 *
 * Flow:
 *   1. create_bounty    — creator locks 0.05 SOL, designates scorer
 *   2. submit_solution  — solver posts a PR with an Opus report hash
 *   3. set_score        — scorer writes the GenLayer verdict on-chain
 *   4. resolve_bounty   — creator pays the solver
 *   5. reads back all state for verification
 *
 * Usage (from repo root):
 *   cd scripts/solana-demo && npm install && npm run demo
 *
 * Requires:
 *   - Solana CLI configured for devnet
 *   - ~/.config/solana/ghbounty-dev.json funded with a few SOL
 *   - Program already deployed (scripts/deploy-solana.sh)
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import idlJson from "./idl.json" with { type: "json" };

const RPC_URL = "https://api.devnet.solana.com";
const KEYPAIR_PATH = path.join(os.homedir(), ".config/solana/ghbounty-dev.json");
const BOUNTY_AMOUNT = 0.05 * LAMPORTS_PER_SOL;
const BOUNTY_ID = new BN(Date.now());

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bountyPda(creator: PublicKey, bountyId: BN, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bounty"), creator.toBuffer(), bountyId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
  return pda;
}

function submissionPda(bounty: PublicKey, index: number, programId: PublicKey): PublicKey {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(index, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("submission"), bounty.toBuffer(), indexBuf],
    programId,
  );
  return pda;
}

async function confirm(conn: Connection, sig: string, label: string): Promise<void> {
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  ✓ ${label}: ${sig}`);
}

async function fundIfNeeded(
  conn: Connection,
  payer: Keypair,
  recipient: PublicKey,
  lamports: number,
  label: string,
): Promise<void> {
  const balance = await conn.getBalance(recipient);
  if (balance >= lamports) return;
  const needed = lamports - balance;
  console.log(`  Funding ${label} with ${needed / LAMPORTS_PER_SOL} SOL`);
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: needed }),
  );
  const sig = await conn.sendTransaction(tx, [payer]);
  await confirm(conn, sig, `fund ${label}`);
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const creator = loadKeypair(KEYPAIR_PATH);
  const solver = Keypair.generate();
  const scorer = Keypair.generate();

  console.log(`Creator: ${creator.publicKey.toBase58()}`);
  console.log(`Solver:  ${solver.publicKey.toBase58()}`);
  console.log(`Scorer:  ${scorer.publicKey.toBase58()}`);
  console.log(`Bounty ID: ${BOUNTY_ID.toString()}\n`);

  const creatorBalance = await connection.getBalance(creator.publicKey);
  console.log(`Creator balance: ${creatorBalance / LAMPORTS_PER_SOL} SOL`);
  if (creatorBalance < 0.2 * LAMPORTS_PER_SOL) {
    throw new Error("Creator needs at least 0.2 SOL. Try `solana airdrop 2`.");
  }

  console.log("\nFunding solver and scorer for rent + fees...");
  await fundIfNeeded(connection, creator, solver.publicKey, 0.02 * LAMPORTS_PER_SOL, "solver");
  await fundIfNeeded(connection, creator, scorer.publicKey, 0.01 * LAMPORTS_PER_SOL, "scorer");

  const provider = new AnchorProvider(connection, new Wallet(creator), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program(idlJson as anchor.Idl, provider);
  const programId = program.programId;
  const bounty = bountyPda(creator.publicKey, BOUNTY_ID, programId);
  const submission = submissionPda(bounty, 0, programId);

  console.log(`\nProgram ID: ${programId.toBase58()}`);
  console.log(`Bounty PDA: ${bounty.toBase58()}`);
  console.log(`Submission PDA: ${submission.toBase58()}\n`);

  // 1. create_bounty
  console.log("1. create_bounty");
  const sig1 = await program.methods
    .createBounty(BOUNTY_ID, new BN(BOUNTY_AMOUNT), scorer.publicKey, "https://github.com/x/y/issues/42")
    .accounts({
      creator: creator.publicKey,
      bounty,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirm(connection, sig1, "create_bounty");

  // 2. submit_solution
  console.log("\n2. submit_solution");
  const opusReportHash = new Uint8Array(32).fill(7);
  const sig2 = await program.methods
    .submitSolution("https://github.com/x/y/pull/99", Array.from(opusReportHash))
    .accounts({
      solver: solver.publicKey,
      bounty,
      submission,
      systemProgram: SystemProgram.programId,
    })
    .signers([solver])
    .rpc();
  await confirm(connection, sig2, "submit_solution");

  // 3. set_score
  console.log("\n3. set_score (scorer writes GenLayer verdict)");
  const sig3 = await program.methods
    .setScore(8)
    .accounts({
      scorer: scorer.publicKey,
      bounty,
      submission,
    })
    .signers([scorer])
    .rpc();
  await confirm(connection, sig3, "set_score");

  // 4. resolve_bounty
  console.log("\n4. resolve_bounty (creator pays solver)");
  const solverBefore = await connection.getBalance(solver.publicKey);
  const sig4 = await program.methods
    .resolveBounty()
    .accounts({
      creator: creator.publicKey,
      bounty,
      winningSubmission: submission,
      winner: solver.publicKey,
    })
    .rpc();
  await confirm(connection, sig4, "resolve_bounty");
  const solverAfter = await connection.getBalance(solver.publicKey);
  console.log(`  Solver balance delta: +${(solverAfter - solverBefore) / LAMPORTS_PER_SOL} SOL`);

  // 5. read state
  console.log("\n5. Final state");
  const bountyAcc = await (program.account as any).bounty.fetch(bounty);
  const submissionAcc = await (program.account as any).submission.fetch(submission);

  console.log("Bounty:");
  console.log(`  state:            ${Object.keys(bountyAcc.state)[0]}`);
  console.log(`  creator:          ${bountyAcc.creator.toBase58()}`);
  console.log(`  scorer:           ${bountyAcc.scorer.toBase58()}`);
  console.log(`  amount:           ${bountyAcc.amount.toString()} lamports`);
  console.log(`  winner:           ${bountyAcc.winner ? bountyAcc.winner.toBase58() : "<none>"}`);
  console.log(`  submission_count: ${bountyAcc.submissionCount}`);

  console.log("Submission:");
  console.log(`  state:            ${Object.keys(submissionAcc.state)[0]}`);
  console.log(`  solver:           ${submissionAcc.solver.toBase58()}`);
  console.log(`  score:            ${submissionAcc.score}`);
  console.log(`  pr_url:           ${submissionAcc.prUrl}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
