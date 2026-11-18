//! Random buys and sells against the real programs, with the buy fee at 0 and at 100 bps. After every trade (a
//! refused one too) the chain must agree with a model of the pool and these must hold:
//!   - pool lamports - rent == sol_reserve - virtual_sol           (the pool holds exactly its real SOL)
//!   - the payout wallet received exactly the sum of the fees      (buy fees and sell fees)
//!   - k = sol_reserve * token_reserve never shrinks, and tokens are conserved
//! At the end every holder sells everything back: no sell may trip the PoolShort guard, and the only sells that
//! fail are dust ones whose SOL rounds to zero.
mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const TRADERS: usize = 6;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
}

fn trades_per_run() -> usize { std::env::var("PROP_TRADES").ok().and_then(|v| v.parse().ok()).unwrap_or(2500) }

fn run(buy_fee_bps: u16, seed: u64) {
    let mut w = launch(Opts { buy_fee_bps, ..Opts::default() });
    let (v, rent) = (w.virtual_sol(), w.pool_rent());
    let traders: Vec<Keypair> = (0..TRADERS).map(|_| Keypair::new()).collect();
    for t in &traders { w.svm.airdrop(&t.pubkey(), 50_000 * SOL).unwrap(); }
    let payout0 = w.lamports(&w.payout.pubkey());
    let mut rng = Rng(seed);
    let (mut s, mut t_res, mut fees) = (v, SUPPLY, 0u64);
    let mut held = [0u64; TRADERS];
    let mut k = s as u128 * t_res as u128;
    let (mut buys, mut sells, mut refused) = (0, 0, 0);

    for i in 0..trades_per_run() {
        let ti = (rng.next() % TRADERS as u64) as usize;
        let user = traders[ti].insecure_clone();
        let sell = held[ti] > 0 && rng.next() % 5 < 2;
        if !sell {
            let bits = 1 + rng.next() % 35; // 1 lamport up to about 34 SOL, log-uniform so dust is common
            let sol_in = 1 + rng.next() % (1u64 << bits);
            let fee = fee_of(sol_in, buy_fee_bps);
            let net = sol_in - fee;
            let out = quote(net, s, t_res);
            let r = w.trade(&user, true, sol_in, 1);
            if out == 0 {
                let e = r.expect_err("a buy that prices to zero tokens must be refused");
                assert_eq!(custom_code(&e), Some(ERR_SLIPPAGE), "{e}");
                refused += 1;
            } else {
                r.unwrap_or_else(|e| panic!("trade {i}: buy {sol_in} failed: {e}"));
                s += net;
                t_res -= out;
                fees += fee;
                held[ti] += out;
                buys += 1;
            }
        } else {
            let tokens_in = if rng.next() % 3 == 0 { held[ti] } else { 1 + rng.next() % held[ti] };
            let gross = quote(tokens_in, t_res, s);
            let fee = fee_of(gross, 1500);
            let r = w.trade(&user, false, tokens_in, 1);
            if gross - fee == 0 {
                let e = r.expect_err("a sell that pays nothing must be refused");
                assert_eq!(custom_code(&e), Some(ERR_SLIPPAGE), "{e}");
                refused += 1;
            } else {
                r.unwrap_or_else(|e| panic!("trade {i}: sell {tokens_in} failed: {e}"));
                s -= gross;
                t_res += tokens_in;
                fees += fee;
                held[ti] -= tokens_in;
                sells += 1;
            }
        }
        assert_eq!(w.sol_reserve(), s, "trade {i}: curve SOL");
        assert_eq!(w.tokens(&w.pool), t_res, "trade {i}: vault tokens");
        assert_eq!(w.lamports(&w.pool), rent + s - v, "trade {i}: pool lamports = rent + sol_reserve - virtual_sol");
        assert_eq!(w.lamports(&w.payout.pubkey()) - payout0, fees, "trade {i}: payout got exactly the fees");
        assert!(s as u128 * t_res as u128 >= k, "trade {i}: k shrank");
        k = s as u128 * t_res as u128;
        for (j, u) in traders.iter().enumerate() { assert_eq!(w.tokens(&u.pubkey()), held[j], "trade {i}: holder {j} balance"); }
        assert_eq!(held.iter().sum::<u64>() + t_res, SUPPLY, "trade {i}: tokens conserved");
    }
    assert!(buys > 100 && sells > 100, "the run should mix both sides (buys {buys}, sells {sells})");

    // Everyone sells everything back, in a shuffled order. The guard must never trip.
    let mut order: Vec<usize> = (0..TRADERS).collect();
    for i in (1..order.len()).rev() { order.swap(i, (rng.next() % (i as u64 + 1)) as usize); }
    for ti in order {
        if held[ti] == 0 { continue; }
        let user = traders[ti].insecure_clone();
        let gross = quote(held[ti], t_res, s);
        let fee = fee_of(gross, 1500);
        match w.trade(&user, false, held[ti], 1) {
            Ok(()) => {
                s -= gross; t_res += held[ti]; fees += fee; held[ti] = 0;
            }
            Err(e) => {
                assert_ne!(custom_code(&e), Some(ERR_POOL_SHORT), "the pool ran short of SOL for a full sell-back: {e}");
                assert_eq!(gross - fee, 0, "only a dust sell may fail: {e}");
                assert_eq!(custom_code(&e), Some(ERR_SLIPPAGE), "{e}");
            }
        }
        assert_eq!(w.lamports(&w.pool), rent + s - v);
        assert!(w.lamports(&w.pool) >= rent, "the pool never goes below its rent");
    }
    assert_eq!(w.lamports(&w.payout.pubkey()) - payout0, fees, "payout got exactly the fees, sell-back included");
    assert!(s >= v, "the curve never holds less than the virtual seed once everyone is out");
    assert_eq!(held.iter().sum::<u64>() + t_res, SUPPLY);
    eprintln!("buy fee {buy_fee_bps} bps: {buys} buys, {sells} sells, {refused} refused, fees {fees} lamports, real SOL left {}", s - v);
}

#[test]
fn random_trades_keep_the_books_with_no_buy_fee() { run(0, 0xC017); }

#[test]
fn random_trades_keep_the_books_with_a_100_bps_buy_fee() { run(100, 0xB0A7); }
