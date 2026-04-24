pub mod constants;
pub mod error;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

use crate::constants::{BOUNTY_SEED, MAX_URL_LEN, SUBMISSION_SEED};
use crate::error::EscrowError;
use crate::state::{Bounty, BountyState, Submission, SubmissionState};

declare_id!("CPZx26QXs3HjwGobr8cVAZEtF1qGzqnNbBdt7h1EwbBg");

#[program]
pub mod ghbounty_escrow {
    use super::*;

    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        bounty_id: u64,
        amount: u64,
        github_issue_url: String,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(
            github_issue_url.len() <= MAX_URL_LEN,
            EscrowError::UrlTooLong
        );

        let ix = system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &ctx.accounts.bounty.key(),
            amount,
        );
        invoke(
            &ix,
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.bounty.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let bounty = &mut ctx.accounts.bounty;
        bounty.creator = ctx.accounts.creator.key();
        bounty.bounty_id = bounty_id;
        bounty.mint = Pubkey::default();
        bounty.amount = amount;
        bounty.state = BountyState::Open;
        bounty.submission_count = 0;
        bounty.winner = None;
        bounty.github_issue_url = github_issue_url;
        bounty.created_at = Clock::get()?.unix_timestamp;
        bounty.bump = ctx.bumps.bounty;

        Ok(())
    }

    pub fn submit_solution(
        ctx: Context<SubmitSolution>,
        pr_url: String,
        opus_report_hash: [u8; 32],
    ) -> Result<()> {
        require!(pr_url.len() <= MAX_URL_LEN, EscrowError::UrlTooLong);

        let bounty = &mut ctx.accounts.bounty;
        let submission = &mut ctx.accounts.submission;

        submission.bounty = bounty.key();
        submission.solver = ctx.accounts.solver.key();
        submission.submission_index = bounty.submission_count;
        submission.pr_url = pr_url;
        submission.opus_report_hash = opus_report_hash;
        submission.score = None;
        submission.state = SubmissionState::Pending;
        submission.created_at = Clock::get()?.unix_timestamp;
        submission.bump = ctx.bumps.submission;

        bounty.submission_count = bounty
            .submission_count
            .checked_add(1)
            .expect("submission_count overflow");

        Ok(())
    }

    pub fn resolve_bounty(ctx: Context<ResolveBounty>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        let submission = &mut ctx.accounts.winning_submission;
        let winner = &ctx.accounts.winner;

        require_keys_eq!(
            winner.key(),
            submission.solver,
            EscrowError::SubmissionMismatch
        );

        let amount = bounty.amount;
        **bounty.to_account_info().try_borrow_mut_lamports()? -= amount;
        **winner.to_account_info().try_borrow_mut_lamports()? += amount;

        bounty.state = BountyState::Resolved;
        bounty.winner = Some(submission.solver);
        submission.state = SubmissionState::Winner;

        Ok(())
    }

    pub fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        let creator = &ctx.accounts.creator;

        let amount = bounty.amount;
        **bounty.to_account_info().try_borrow_mut_lamports()? -= amount;
        **creator.to_account_info().try_borrow_mut_lamports()? += amount;

        bounty.state = BountyState::Cancelled;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(bounty_id: u64)]
pub struct CreateBounty<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [BOUNTY_SEED, creator.key().as_ref(), &bounty_id.to_le_bytes()],
        bump,
    )]
    pub bounty: Account<'info, Bounty>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitSolution<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,

    #[account(
        mut,
        constraint = bounty.state == BountyState::Open @ EscrowError::BountyNotOpen,
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        init,
        payer = solver,
        space = 8 + Submission::INIT_SPACE,
        seeds = [
            SUBMISSION_SEED,
            bounty.key().as_ref(),
            &bounty.submission_count.to_le_bytes(),
        ],
        bump,
    )]
    pub submission: Account<'info, Submission>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveBounty<'info> {
    #[account(
        constraint = creator.key() == bounty.creator @ EscrowError::UnauthorizedCreator,
    )]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = bounty.state == BountyState::Open @ EscrowError::BountyNotOpen,
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        mut,
        constraint = winning_submission.bounty == bounty.key() @ EscrowError::SubmissionMismatch,
    )]
    pub winning_submission: Account<'info, Submission>,

    /// CHECK: validated against submission.solver in handler.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelBounty<'info> {
    #[account(
        mut,
        constraint = creator.key() == bounty.creator @ EscrowError::UnauthorizedCreator,
    )]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint = bounty.state == BountyState::Open @ EscrowError::BountyNotOpen,
    )]
    pub bounty: Account<'info, Bounty>,
}
