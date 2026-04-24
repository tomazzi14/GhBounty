use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use ghbounty_escrow::state::{Bounty, BountyState, Submission, SubmissionState};
use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::{v0, VersionedMessage};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;
use solana_transaction::versioned::VersionedTransaction;

const PROGRAM_ID: Pubkey = ghbounty_escrow::ID;
const PROGRAM_SO: &[u8] = include_bytes!("../../../target/deploy/ghbounty_escrow.so");

const ONE_SOL: u64 = 1_000_000_000;

// ── Helpers ────────────────────────────────────────────────────────────────

fn setup() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(PROGRAM_ID, PROGRAM_SO).unwrap();
    svm
}

fn funded(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), lamports).unwrap();
    kp
}

fn bounty_pda(creator: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"bounty", creator.as_ref(), &id.to_le_bytes()],
        &PROGRAM_ID,
    )
    .0
}

fn submission_pda(bounty: &Pubkey, index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"submission", bounty.as_ref(), &index.to_le_bytes()],
        &PROGRAM_ID,
    )
    .0
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction, extra_signers: &[&Keypair]) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let blockhash = svm.latest_blockhash();
    let msg = v0::Message::try_compile(&payer.pubkey(), &[ix], &[], blockhash).unwrap();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &signers).unwrap();
    svm.send_transaction(tx).map(|_| ())
}

fn create_bounty_ix(
    creator: &Pubkey,
    bounty_id: u64,
    amount: u64,
    github_issue_url: &str,
) -> Instruction {
    create_bounty_ix_with_scorer(creator, bounty_id, amount, creator, github_issue_url)
}

fn create_bounty_ix_with_scorer(
    creator: &Pubkey,
    bounty_id: u64,
    amount: u64,
    scorer: &Pubkey,
    github_issue_url: &str,
) -> Instruction {
    let bounty = bounty_pda(creator, bounty_id);
    let accounts = ghbounty_escrow::accounts::CreateBounty {
        creator: *creator,
        bounty,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    let data = ghbounty_escrow::instruction::CreateBounty {
        bounty_id,
        amount,
        scorer: *scorer,
        github_issue_url: github_issue_url.to_string(),
    }
    .data();
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

fn set_score_ix(
    scorer: &Pubkey,
    bounty: &Pubkey,
    submission: &Pubkey,
    score: u8,
) -> Instruction {
    let accounts = ghbounty_escrow::accounts::SetScore {
        scorer: *scorer,
        bounty: *bounty,
        submission: *submission,
    }
    .to_account_metas(None);
    let data = ghbounty_escrow::instruction::SetScore { score }.data();
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

fn submit_solution_ix(
    solver: &Pubkey,
    bounty: &Pubkey,
    submission_index: u32,
    pr_url: &str,
    opus_report_hash: [u8; 32],
) -> Instruction {
    let submission = submission_pda(bounty, submission_index);
    let accounts = ghbounty_escrow::accounts::SubmitSolution {
        solver: *solver,
        bounty: *bounty,
        submission,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    let data = ghbounty_escrow::instruction::SubmitSolution {
        pr_url: pr_url.to_string(),
        opus_report_hash,
    }
    .data();
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

fn resolve_bounty_ix(
    creator: &Pubkey,
    bounty: &Pubkey,
    winning_submission: &Pubkey,
    winner: &Pubkey,
) -> Instruction {
    let accounts = ghbounty_escrow::accounts::ResolveBounty {
        creator: *creator,
        bounty: *bounty,
        winning_submission: *winning_submission,
        winner: *winner,
    }
    .to_account_metas(None);
    let data = ghbounty_escrow::instruction::ResolveBounty {}.data();
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

fn cancel_bounty_ix(creator: &Pubkey, bounty: &Pubkey) -> Instruction {
    let accounts = ghbounty_escrow::accounts::CancelBounty {
        creator: *creator,
        bounty: *bounty,
    }
    .to_account_metas(None);
    let data = ghbounty_escrow::instruction::CancelBounty {}.data();
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

fn read_bounty(svm: &LiteSVM, pda: &Pubkey) -> Bounty {
    let acc = svm.get_account(pda).unwrap();
    Bounty::try_deserialize(&mut acc.data.as_ref()).unwrap()
}

fn read_submission(svm: &LiteSVM, pda: &Pubkey) -> Submission {
    let acc = svm.get_account(pda).unwrap();
    Submission::try_deserialize(&mut acc.data.as_ref()).unwrap()
}

// ── Happy path ─────────────────────────────────────────────────────────────

#[test]
fn create_submit_resolve_happy_path() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);

    let bounty_id = 1u64;
    let amount = 2 * ONE_SOL;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, amount, "https://github.com/x/y/issues/42"),
        &[],
    )
    .unwrap();

    let b = read_bounty(&svm, &bounty);
    assert_eq!(b.creator, creator.pubkey());
    assert_eq!(b.amount, amount);
    assert_eq!(b.state, BountyState::Open);
    assert_eq!(b.submission_count, 0);

    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "https://github.com/x/y/pull/99", [1u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    let s = read_submission(&svm, &submission);
    assert_eq!(s.solver, solver.pubkey());
    assert_eq!(s.state, SubmissionState::Pending);
    assert_eq!(read_bounty(&svm, &bounty).submission_count, 1);

    let solver_before = svm.get_account(&solver.pubkey()).unwrap().lamports;

    send(
        &mut svm,
        &creator,
        resolve_bounty_ix(&creator.pubkey(), &bounty, &submission, &solver.pubkey()),
        &[],
    )
    .unwrap();

    let solver_after = svm.get_account(&solver.pubkey()).unwrap().lamports;
    assert_eq!(solver_after - solver_before, amount);

    let b = read_bounty(&svm, &bounty);
    assert_eq!(b.state, BountyState::Resolved);
    assert_eq!(b.winner, Some(solver.pubkey()));

    let s = read_submission(&svm, &submission);
    assert_eq!(s.state, SubmissionState::Winner);
}

// ── Cancel refunds creator ─────────────────────────────────────────────────

#[test]
fn cancel_refunds_creator() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let bounty_id = 7u64;
    let amount = 3 * ONE_SOL;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, amount, ""),
        &[],
    )
    .unwrap();

    let creator_before = svm.get_account(&creator.pubkey()).unwrap().lamports;

    send(&mut svm, &creator, cancel_bounty_ix(&creator.pubkey(), &bounty), &[]).unwrap();

    let creator_after = svm.get_account(&creator.pubkey()).unwrap().lamports;
    assert!(creator_after > creator_before);
    assert_eq!(read_bounty(&svm, &bounty).state, BountyState::Cancelled);
}

// ── Auth: only creator can resolve/cancel ──────────────────────────────────

#[test]
fn non_creator_cannot_resolve() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let attacker = funded(&mut svm, ONE_SOL);

    let bounty_id = 3u64;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    let err = send(
        &mut svm,
        &attacker,
        resolve_bounty_ix(&attacker.pubkey(), &bounty, &submission, &solver.pubkey()),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("UnauthorizedCreator"));
}

#[test]
fn non_creator_cannot_cancel() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let attacker = funded(&mut svm, ONE_SOL);

    let bounty_id = 4u64;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, ONE_SOL, ""),
        &[],
    )
    .unwrap();

    let err = send(
        &mut svm,
        &attacker,
        cancel_bounty_ix(&attacker.pubkey(), &bounty),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("UnauthorizedCreator"));
}

// ── State machine ──────────────────────────────────────────────────────────

#[test]
fn cannot_submit_after_cancel() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);

    let bounty_id = 5u64;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(&mut svm, &creator, cancel_bounty_ix(&creator.pubkey(), &bounty), &[]).unwrap();

    let err = send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("BountyNotOpen"));
}

#[test]
fn cannot_resolve_twice() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);

    let bounty_id = 6u64;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    send(
        &mut svm,
        &creator,
        resolve_bounty_ix(&creator.pubkey(), &bounty, &submission, &solver.pubkey()),
        &[],
    )
    .unwrap();

    svm.expire_blockhash();

    let err = send(
        &mut svm,
        &creator,
        resolve_bounty_ix(&creator.pubkey(), &bounty, &submission, &solver.pubkey()),
        &[],
    )
    .unwrap_err();

    let msg = format!("{err:?}");
    assert!(msg.contains("BountyNotOpen"), "unexpected error: {msg}");
}

// ── Winner validation ──────────────────────────────────────────────────────

#[test]
fn winner_must_match_submission_solver() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let impostor = funded(&mut svm, ONE_SOL);

    let bounty_id = 8u64;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    let err = send(
        &mut svm,
        &creator,
        resolve_bounty_ix(&creator.pubkey(), &bounty, &submission, &impostor.pubkey()),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("SubmissionMismatch"));
}

#[test]
fn resolve_rejects_submission_from_other_bounty() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);

    let bounty_a = bounty_pda(&creator.pubkey(), 10);
    let bounty_b = bounty_pda(&creator.pubkey(), 11);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 10, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 11, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty_a, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission_a = submission_pda(&bounty_a, 0);
    let err = send(
        &mut svm,
        &creator,
        resolve_bounty_ix(&creator.pubkey(), &bounty_b, &submission_a, &solver.pubkey()),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("SubmissionMismatch"));
}

// ── Input validation ───────────────────────────────────────────────────────

#[test]
fn zero_amount_rejected() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);

    let err = send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 12, 0, ""),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("ZeroAmount"));
}

#[test]
fn url_too_long_rejected() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let long = "a".repeat(201);

    let err = send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 13, ONE_SOL, &long),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("UrlTooLong"));
}

// ── Multi-submission ───────────────────────────────────────────────────────

#[test]
fn multiple_submissions_increment_index() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let s1 = funded(&mut svm, ONE_SOL);
    let s2 = funded(&mut svm, ONE_SOL);
    let s3 = funded(&mut svm, ONE_SOL);

    let bounty_id = 20u64;
    let bounty = bounty_pda(&creator.pubkey(), bounty_id);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), bounty_id, ONE_SOL, ""),
        &[],
    )
    .unwrap();

    for (i, solver) in [&s1, &s2, &s3].iter().enumerate() {
        send(
            &mut svm,
            solver,
            submit_solution_ix(&solver.pubkey(), &bounty, i as u32, "pr", [i as u8; 32]),
            &[],
        )
        .unwrap();
    }

    let b = read_bounty(&svm, &bounty);
    assert_eq!(b.submission_count, 3);

    for i in 0..3 {
        let sub = read_submission(&svm, &submission_pda(&bounty, i));
        assert_eq!(sub.submission_index, i);
    }
}

// ── Edge cases ─────────────────────────────────────────────────────────────

#[test]
fn duplicate_bounty_id_rejected() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 42, ONE_SOL, ""),
        &[],
    )
    .unwrap();

    svm.expire_blockhash();

    let err = send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 42, ONE_SOL, ""),
        &[],
    )
    .unwrap_err();

    let msg = format!("{err:?}");
    assert!(
        msg.contains("already in use") || msg.contains("0x0"),
        "unexpected error: {msg}"
    );
}

#[test]
fn bounty_id_zero_is_valid() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 0);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 0, ONE_SOL, ""),
        &[],
    )
    .unwrap();

    let b = read_bounty(&svm, &bounty);
    assert_eq!(b.bounty_id, 0);
    assert_eq!(b.state, BountyState::Open);
}

#[test]
fn url_exactly_200_chars_accepted() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let url = "a".repeat(200);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 50, ONE_SOL, &url),
        &[],
    )
    .unwrap();

    let b = read_bounty(&svm, &bounty_pda(&creator.pubkey(), 50));
    assert_eq!(b.github_issue_url.len(), 200);
}

#[test]
fn empty_urls_accepted() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 51);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 51, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "", [0u8; 32]),
        &[],
    )
    .unwrap();

    let b = read_bounty(&svm, &bounty);
    let s = read_submission(&svm, &submission_pda(&bounty, 0));
    assert_eq!(b.github_issue_url, "");
    assert_eq!(s.pr_url, "");
}

#[test]
fn creator_can_submit_to_own_bounty() {
    // MVP allows self-submission. Off-chain ranking surfaces the self-deal
    // risk; on-chain we do not restrict because legitimate self-fulfilment
    // (e.g. company pays its own contractor via the bounty rail) is valid.
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 60);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 60, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &creator,
        submit_solution_ix(&creator.pubkey(), &bounty, 0, "self-pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let s = read_submission(&svm, &submission_pda(&bounty, 0));
    assert_eq!(s.solver, creator.pubkey());
}

#[test]
fn cancel_with_pending_submissions_succeeds() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let s1 = funded(&mut svm, ONE_SOL);
    let s2 = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 70);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 70, ONE_SOL, ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &s1,
        submit_solution_ix(&s1.pubkey(), &bounty, 0, "pr1", [1u8; 32]),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &s2,
        submit_solution_ix(&s2.pubkey(), &bounty, 1, "pr2", [2u8; 32]),
        &[],
    )
    .unwrap();

    send(&mut svm, &creator, cancel_bounty_ix(&creator.pubkey(), &bounty), &[]).unwrap();

    // Bounty cancelled with submissions still on-chain; solvers' rent is
    // retained in their Submission PDAs (not refunded here — future cleanup
    // instruction could reclaim).
    let b = read_bounty(&svm, &bounty);
    assert_eq!(b.state, BountyState::Cancelled);
    assert_eq!(b.submission_count, 2);

    let s = read_submission(&svm, &submission_pda(&bounty, 0));
    assert_eq!(s.state, SubmissionState::Pending);
}

#[test]
fn multi_bounty_same_creator_isolated() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);

    let b1 = bounty_pda(&creator.pubkey(), 100);
    let b2 = bounty_pda(&creator.pubkey(), 101);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 100, ONE_SOL, "b1"),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 101, 2 * ONE_SOL, "b2"),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &b1, 0, "pr-b1", [0u8; 32]),
        &[],
    )
    .unwrap();

    // Submission on b1 must not affect b2.
    assert_eq!(read_bounty(&svm, &b1).submission_count, 1);
    assert_eq!(read_bounty(&svm, &b2).submission_count, 0);
    assert_eq!(read_bounty(&svm, &b1).amount, ONE_SOL);
    assert_eq!(read_bounty(&svm, &b2).amount, 2 * ONE_SOL);

    // Cancelling b1 leaves b2 untouched.
    svm.expire_blockhash();
    send(&mut svm, &creator, cancel_bounty_ix(&creator.pubkey(), &b1), &[]).unwrap();
    assert_eq!(read_bounty(&svm, &b1).state, BountyState::Cancelled);
    assert_eq!(read_bounty(&svm, &b2).state, BountyState::Open);
}

// ── set_score ──────────────────────────────────────────────────────────────

#[test]
fn scorer_can_set_score_once() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let scorer = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 200);

    send(
        &mut svm,
        &creator,
        create_bounty_ix_with_scorer(&creator.pubkey(), 200, ONE_SOL, &scorer.pubkey(), ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    send(
        &mut svm,
        &scorer,
        set_score_ix(&scorer.pubkey(), &bounty, &submission, 8),
        &[],
    )
    .unwrap();

    let s = read_submission(&svm, &submission);
    assert_eq!(s.score, Some(8));
    assert_eq!(s.state, SubmissionState::Scored);
}

#[test]
fn non_scorer_cannot_set_score() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let scorer = funded(&mut svm, ONE_SOL);
    let attacker = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 201);

    send(
        &mut svm,
        &creator,
        create_bounty_ix_with_scorer(&creator.pubkey(), 201, ONE_SOL, &scorer.pubkey(), ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    let err = send(
        &mut svm,
        &attacker,
        set_score_ix(&attacker.pubkey(), &bounty, &submission, 7),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("UnauthorizedScorer"));
}

#[test]
fn score_out_of_range_rejected() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let scorer = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 202);

    send(
        &mut svm,
        &creator,
        create_bounty_ix_with_scorer(&creator.pubkey(), 202, ONE_SOL, &scorer.pubkey(), ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    let err = send(
        &mut svm,
        &scorer,
        set_score_ix(&scorer.pubkey(), &bounty, &submission, 0),
        &[],
    )
    .unwrap_err();
    assert!(format!("{err:?}").contains("ScoreOutOfRange"));

    svm.expire_blockhash();
    let err = send(
        &mut svm,
        &scorer,
        set_score_ix(&scorer.pubkey(), &bounty, &submission, 11),
        &[],
    )
    .unwrap_err();
    assert!(format!("{err:?}").contains("ScoreOutOfRange"));
}

#[test]
fn double_score_rejected() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let scorer = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 203);

    send(
        &mut svm,
        &creator,
        create_bounty_ix_with_scorer(&creator.pubkey(), 203, ONE_SOL, &scorer.pubkey(), ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();

    let submission = submission_pda(&bounty, 0);
    send(
        &mut svm,
        &scorer,
        set_score_ix(&scorer.pubkey(), &bounty, &submission, 7),
        &[],
    )
    .unwrap();

    svm.expire_blockhash();
    let err = send(
        &mut svm,
        &scorer,
        set_score_ix(&scorer.pubkey(), &bounty, &submission, 9),
        &[],
    )
    .unwrap_err();
    assert!(format!("{err:?}").contains("ScoreAlreadySet"));
}

#[test]
fn cannot_score_after_cancel() {
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let scorer = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 204);

    send(
        &mut svm,
        &creator,
        create_bounty_ix_with_scorer(&creator.pubkey(), 204, ONE_SOL, &scorer.pubkey(), ""),
        &[],
    )
    .unwrap();
    send(
        &mut svm,
        &solver,
        submit_solution_ix(&solver.pubkey(), &bounty, 0, "pr", [0u8; 32]),
        &[],
    )
    .unwrap();
    send(&mut svm, &creator, cancel_bounty_ix(&creator.pubkey(), &bounty), &[]).unwrap();

    let submission = submission_pda(&bounty, 0);
    let err = send(
        &mut svm,
        &scorer,
        set_score_ix(&scorer.pubkey(), &bounty, &submission, 7),
        &[],
    )
    .unwrap_err();

    assert!(format!("{err:?}").contains("BountyNotOpen"));
}

#[test]
fn submit_with_wrong_index_fails() {
    // The submission seed is derived from bounty.submission_count. Passing
    // a PDA built with a different index yields ConstraintSeeds.
    let mut svm = setup();
    let creator = funded(&mut svm, 10 * ONE_SOL);
    let solver = funded(&mut svm, ONE_SOL);
    let bounty = bounty_pda(&creator.pubkey(), 80);

    send(
        &mut svm,
        &creator,
        create_bounty_ix(&creator.pubkey(), 80, ONE_SOL, ""),
        &[],
    )
    .unwrap();

    // Build an ix whose submission PDA uses index=5 while bounty.submission_count=0.
    let wrong_submission = submission_pda(&bounty, 5);
    let accounts = ghbounty_escrow::accounts::SubmitSolution {
        solver: solver.pubkey(),
        bounty,
        submission: wrong_submission,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    let data = ghbounty_escrow::instruction::SubmitSolution {
        pr_url: "pr".to_string(),
        opus_report_hash: [0u8; 32],
    }
    .data();
    let ix = Instruction { program_id: PROGRAM_ID, accounts, data };

    let err = send(&mut svm, &solver, ix, &[]).unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        msg.contains("ConstraintSeeds") || msg.contains("2006"),
        "unexpected error: {msg}"
    );
}
