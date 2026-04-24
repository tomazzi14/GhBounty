use anchor_lang::prelude::*;

#[constant]
pub const BOUNTY_SEED: &[u8] = b"bounty";

#[constant]
pub const SUBMISSION_SEED: &[u8] = b"submission";

pub const MAX_URL_LEN: usize = 200;
pub const MIN_SCORE: u8 = 1;
pub const MAX_SCORE: u8 = 10;
