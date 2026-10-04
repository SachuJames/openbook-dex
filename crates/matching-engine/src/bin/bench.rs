//! Matching engine throughput benchmark.
//!
//! Inserts 200,000 limit orders, then matches them with 200,000 crossing
//! taker orders, printing measured orders/sec for each phase separately.
//! Run with: cargo run --release --bin bench

use openbook_engine::{Engine, Event, NewOrder, OrderType, Side};
use std::time::Instant;

const N: usize = 200_000;
const SYMBOL: &str = "BENCH/USDC";
const QTY: u128 = 1_000_000_000_000_000_000; // 1.0 base token
const BASE_PRICE: u128 = 10_000_000_000; // 100.0 quote per base (scaled 1e8)

fn main() {
    let mut engine = Engine::new();

    // Phase 1: rest 200,000 asks across 2,000 price levels.
    let start = Instant::now();
    for i in 0..N {
        let id = format!("ask-{i}");
        let trader = format!("0xmaker{:03x}", i % 128);
        let price = BASE_PRICE + (i as u128 % 2000) * 1_000_000;
        engine
            .place_order(NewOrder {
                symbol: SYMBOL,
                order_id: &id,
                trader: &trader,
                side: Side::Ask,
                order_type: OrderType::Limit,
                price: Some(price),
                qty: QTY,
            })
            .expect("insert failed");
    }
    let insert_secs = start.elapsed().as_secs_f64();
    println!(
        "insert: {N} limit orders in {insert_secs:.3}s = {:.0} orders/sec",
        N as f64 / insert_secs
    );

    // Phase 2: sweep them with 200,000 crossing bids, one fill each.
    let start = Instant::now();
    let mut trades = 0usize;
    for i in 0..N {
        let id = format!("bid-{i}");
        let trader = format!("0xtaker{:03x}", i % 128);
        let events = engine
            .place_order(NewOrder {
                symbol: SYMBOL,
                order_id: &id,
                trader: &trader,
                side: Side::Bid,
                order_type: OrderType::Limit,
                price: Some(BASE_PRICE * 10),
                qty: QTY,
            })
            .expect("match failed");
        trades += events
            .iter()
            .filter(|e| matches!(e, Event::Trade { .. }))
            .count();
    }
    let match_secs = start.elapsed().as_secs_f64();
    println!(
        "match:  {N} taker orders ({trades} trades) in {match_secs:.3}s = {:.0} orders/sec",
        N as f64 / match_secs
    );
}
