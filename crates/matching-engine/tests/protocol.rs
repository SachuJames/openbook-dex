//! Protocol-level tests for the OpenBook matching engine.
//!
//! Every test drives the engine through `handle_line`, the same entry point
//! the stdio binary uses, so these verify the wire protocol end to end.

use openbook_engine::Engine;
use serde_json::Value;

fn send(engine: &mut Engine, line: &str) -> Value {
    let out = engine
        .handle_line(line)
        .expect("a non-empty line always gets a response");
    serde_json::from_str(&out).expect("the response is valid JSON")
}

fn is_ok(v: &Value) -> bool {
    v["ok"].as_bool().unwrap_or(false)
}

fn events(v: &Value) -> Vec<Value> {
    v["events"].as_array().cloned().unwrap_or_default()
}

fn new_order(
    engine: &mut Engine,
    order_id: &str,
    trader: &str,
    side: &str,
    order_type: &str,
    price: Option<&str>,
    qty: &str,
) -> Value {
    let price_field = price
        .map(|p| format!("\"price\": \"{p}\","))
        .unwrap_or_default();
    send(
        engine,
        &format!(
            "{{\"cmd\": \"new_order\", \"symbol\": \"BTC/USDC\", \"order_id\": \"{order_id}\", \
             \"trader\": \"{trader}\", \"side\": \"{side}\", \"type\": \"{order_type}\", \
             {price_field} \"qty\": \"{qty}\"}}"
        ),
    )
}

#[test]
fn basic_limit_cross_trades_at_maker_price() {
    let mut e = Engine::new();
    let r = new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("5000000000000"),
        "10000000000000000000",
    );
    assert!(is_ok(&r));
    assert_eq!(events(&r).len(), 1);
    assert_eq!(events(&r)[0]["type"], "order_accepted");

    let r = new_order(
        &mut e,
        "o2",
        "0xbbb",
        "bid",
        "limit",
        Some("5000000000000"),
        "3000000000000000000",
    );
    assert!(is_ok(&r));
    let ev = events(&r);
    assert_eq!(ev.len(), 2);
    assert_eq!(ev[0]["type"], "order_accepted");
    let t = &ev[1];
    assert_eq!(t["type"], "trade");
    assert_eq!(t["trade_id"], 1);
    assert_eq!(t["ts"], 1);
    assert_eq!(t["symbol"], "BTC/USDC");
    assert_eq!(t["price"], "5000000000000"); // maker price
    assert_eq!(t["qty"], "3000000000000000000");
    assert_eq!(t["taker_order"], "o2");
    assert_eq!(t["maker_order"], "o1");
    assert_eq!(t["taker_trader"], "0xbbb");
    assert_eq!(t["maker_trader"], "0xaaa");
    assert_eq!(t["bid_trader"], "0xbbb");
    assert_eq!(t["ask_trader"], "0xaaa");

    // Maker rests with the remaining 7.
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert!(is_ok(&book));
    assert_eq!(book["bids"].as_array().unwrap().len(), 0);
    assert_eq!(
        book["asks"][0].as_array().unwrap(),
        &vec![
            Value::from("5000000000000"),
            Value::from("7000000000000000000")
        ]
    );
}

#[test]
fn partial_fill_across_multiple_price_levels() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "a1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    new_order(
        &mut e,
        "a2",
        "0xbbb",
        "ask",
        "limit",
        Some("10100000000"),
        "5",
    );

    let r = new_order(
        &mut e,
        "b1",
        "0xccc",
        "bid",
        "limit",
        Some("10100000000"),
        "8",
    );
    assert!(is_ok(&r));
    let ev = events(&r);
    assert_eq!(ev.len(), 3);
    assert_eq!(ev[1]["maker_order"], "a1");
    assert_eq!(ev[1]["price"], "10000000000");
    assert_eq!(ev[1]["qty"], "5");
    assert_eq!(ev[1]["trade_id"], 1);
    assert_eq!(ev[2]["maker_order"], "a2");
    assert_eq!(ev[2]["price"], "10100000000");
    assert_eq!(ev[2]["qty"], "3");
    assert_eq!(ev[2]["trade_id"], 2);
    assert_eq!(ev[2]["ts"], 2);

    // a1 fully filled, a2 rests with 2.
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert_eq!(book["asks"].as_array().unwrap().len(), 1);
    assert_eq!(book["asks"][0][0], "10100000000");
    assert_eq!(book["asks"][0][1], "2");
}

#[test]
fn price_time_priority_better_price_then_earlier_order() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "a1",
        "0xt1",
        "ask",
        "limit",
        Some("10000000000"),
        "2",
    );
    new_order(
        &mut e,
        "a2",
        "0xt2",
        "ask",
        "limit",
        Some("10000000000"),
        "3",
    );
    new_order(
        &mut e,
        "a3",
        "0xt3",
        "ask",
        "limit",
        Some("9900000000"),
        "1",
    );

    let r = new_order(
        &mut e,
        "b1",
        "0xt4",
        "bid",
        "limit",
        Some("10000000000"),
        "4",
    );
    let ev = events(&r);
    let makers: Vec<&str> = ev[1..]
        .iter()
        .map(|t| t["maker_order"].as_str().unwrap())
        .collect();
    // Better price first, then earlier order at the same level.
    assert_eq!(makers, vec!["a3", "a1", "a2"]);
    let qtys: Vec<&str> = ev[1..].iter().map(|t| t["qty"].as_str().unwrap()).collect();
    assert_eq!(qtys, vec!["1", "2", "1"]);
    assert_eq!(ev[1]["price"], "9900000000");
    assert_eq!(ev[2]["price"], "10000000000");
}

#[test]
fn market_order_sweeps_book_and_drops_remainder() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "a1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    new_order(
        &mut e,
        "a2",
        "0xbbb",
        "ask",
        "limit",
        Some("10100000000"),
        "5",
    );

    let r = new_order(&mut e, "m1", "0xccc", "bid", "market", None, "12");
    assert!(is_ok(&r));
    let ev = events(&r);
    // No order_accepted for market orders, and the unfilled remainder is
    // dropped silently: just the two trades.
    assert_eq!(ev.len(), 2);
    assert_eq!(ev[0]["type"], "trade");
    assert_eq!(ev[0]["qty"], "5");
    assert_eq!(ev[1]["type"], "trade");
    assert_eq!(ev[1]["qty"], "5");

    // Nothing rests.
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert!(book["asks"].as_array().unwrap().is_empty());
    assert!(book["bids"].as_array().unwrap().is_empty());
}

#[test]
fn market_order_on_empty_book_is_ok_with_empty_events() {
    let mut e = Engine::new();
    let r = new_order(&mut e, "m1", "0xccc", "bid", "market", None, "10");
    assert!(is_ok(&r));
    assert!(events(&r).is_empty());
}

#[test]
fn cancel_removes_resting_order_and_unknown_cancel_errors() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );

    let r = send(
        &mut e,
        r#"{"cmd": "cancel", "symbol": "BTC/USDC", "order_id": "o1"}"#,
    );
    assert!(is_ok(&r));
    let ev = events(&r);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "order_cancelled");
    assert_eq!(ev[0]["order_id"], "o1");
    assert_eq!(ev[0]["symbol"], "BTC/USDC");

    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert!(book["asks"].as_array().unwrap().is_empty());

    // Cancelling twice is an error.
    let r = send(
        &mut e,
        r#"{"cmd": "cancel", "symbol": "BTC/USDC", "order_id": "o1"}"#,
    );
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("unknown order: o1"));

    // Unknown id is an error.
    let r = send(
        &mut e,
        r#"{"cmd": "cancel", "symbol": "BTC/USDC", "order_id": "nope"}"#,
    );
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("unknown order: nope"));
}

#[test]
fn cancel_of_filled_order_errors() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "2",
    );
    new_order(
        &mut e,
        "o2",
        "0xbbb",
        "bid",
        "limit",
        Some("10000000000"),
        "2",
    );
    let r = send(
        &mut e,
        r#"{"cmd": "cancel", "symbol": "BTC/USDC", "order_id": "o1"}"#,
    );
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("unknown order: o1"));
}

#[test]
fn amend_repositions_and_loses_time_priority() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "10",
    );

    let r = send(
        &mut e,
        r#"{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "o1", "price": "10200000000"}"#,
    );
    assert!(is_ok(&r));
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert_eq!(book["asks"][0][0], "10200000000");
    assert_eq!(book["asks"][0][1], "10");

    // Amend of an unknown order is an error.
    let r = send(
        &mut e,
        r#"{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "ghost", "price": "1"}"#,
    );
    assert!(!is_ok(&r));
    assert!(r["error"]
        .as_str()
        .unwrap()
        .contains("unknown order: ghost"));

    // Time priority: amending a1 (even to the same price) moves it behind a2.
    let mut e = Engine::new();
    new_order(
        &mut e,
        "a1",
        "0xt1",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    new_order(
        &mut e,
        "a2",
        "0xt2",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    let r = send(
        &mut e,
        r#"{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "a1", "price": "10000000000", "qty": "5"}"#,
    );
    assert!(is_ok(&r));
    let r = new_order(
        &mut e,
        "b1",
        "0xt3",
        "bid",
        "limit",
        Some("10000000000"),
        "5",
    );
    let ev = events(&r);
    assert_eq!(ev[1]["maker_order"], "a2");
}

#[test]
fn amend_can_cross_and_match_like_a_fresh_order() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "a1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    new_order(
        &mut e,
        "b1",
        "0xbbb",
        "bid",
        "limit",
        Some("9000000000"),
        "5",
    );
    let r = send(
        &mut e,
        r#"{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "b1", "price": "10000000000"}"#,
    );
    assert!(is_ok(&r));
    let ev = events(&r);
    assert_eq!(ev[0]["type"], "order_cancelled");
    assert_eq!(ev[0]["reason"], "amend");
    assert_eq!(ev[1]["type"], "order_accepted");
    assert_eq!(ev[2]["type"], "trade");
    assert_eq!(ev[2]["maker_order"], "a1");
    assert_eq!(ev[2]["qty"], "5");
}

#[test]
fn self_trade_cancels_resting_order_and_continues() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "o1",
        "0xt",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );

    let r = new_order(
        &mut e,
        "o2",
        "0xt",
        "bid",
        "limit",
        Some("10000000000"),
        "3",
    );
    assert!(is_ok(&r));
    let ev = events(&r);
    assert_eq!(ev.len(), 2);
    assert_eq!(ev[0]["type"], "order_accepted");
    assert_eq!(ev[1]["type"], "order_cancelled");
    assert_eq!(ev[1]["order_id"], "o1");
    assert_eq!(ev[1]["reason"], "self_trade");

    // The taker rests with its full qty; the maker's order is gone.
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert!(book["asks"].as_array().unwrap().is_empty());
    assert_eq!(book["bids"][0][0], "10000000000");
    assert_eq!(book["bids"][0][1], "3");
}

#[test]
fn self_trade_skips_own_order_and_fills_next_maker() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "own",
        "0xt",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    new_order(
        &mut e,
        "other",
        "0xu",
        "ask",
        "limit",
        Some("10000000000"),
        "2",
    );

    let r = new_order(
        &mut e,
        "b1",
        "0xt",
        "bid",
        "limit",
        Some("10000000000"),
        "6",
    );
    assert!(is_ok(&r));
    let ev = events(&r);
    assert_eq!(ev[0]["type"], "order_accepted");
    assert_eq!(ev[1]["type"], "order_cancelled");
    assert_eq!(ev[1]["order_id"], "own");
    assert_eq!(ev[1]["reason"], "self_trade");
    assert_eq!(ev[2]["type"], "trade");
    assert_eq!(ev[2]["maker_order"], "other");
    assert_eq!(ev[2]["qty"], "2");

    // Taker rests with 4.
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert_eq!(book["bids"][0][1], "4");
}

#[test]
fn books_are_isolated_per_symbol() {
    let mut e = Engine::new();
    let r = send(
        &mut e,
        r#"{"cmd": "new_order", "symbol": "ETH/USDC", "order_id": "e1", "trader": "0xaaa",
            "side": "ask", "type": "limit", "price": "300000000000", "qty": "5"}"#,
    );
    assert!(is_ok(&r));
    let r = new_order(
        &mut e,
        "b1",
        "0xbbb",
        "bid",
        "limit",
        Some("5000000000000"),
        "1",
    );
    // The BTC bid does not touch the ETH ask.
    assert_eq!(events(&r).len(), 1);

    let btc = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert_eq!(btc["bids"][0][1], "1");
    assert!(btc["asks"].as_array().unwrap().is_empty());
    let eth = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "ETH/USDC", "depth": 20}"#,
    );
    assert_eq!(eth["asks"][0][1], "5");

    // Per-book counters: a trade on each book gets trade_id 1 and ts 1.
    let r = new_order(
        &mut e,
        "aB",
        "0xeee",
        "ask",
        "limit",
        Some("5000000000000"),
        "1",
    );
    let ev = events(&r);
    assert_eq!(ev[1]["trade_id"], 1);
    assert_eq!(ev[1]["ts"], 1);
    let r = send(
        &mut e,
        r#"{"cmd": "new_order", "symbol": "ETH/USDC", "order_id": "e2", "trader": "0xddd",
            "side": "bid", "type": "limit", "price": "300000000000", "qty": "2"}"#,
    );
    let ev = events(&r);
    assert_eq!(ev[1]["trade_id"], 1);
    assert_eq!(ev[1]["ts"], 1);
    let btc_trades = send(
        &mut e,
        r#"{"cmd": "trades", "symbol": "BTC/USDC", "limit": 50}"#,
    );
    assert_eq!(btc_trades["trades"][0]["trade_id"], 1);
    assert_eq!(btc_trades["trades"][0]["ts"], 1);
}

#[test]
fn replaying_input_twice_gives_identical_output() {
    let script = [
        r#"{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "a1", "trader": "0xaaa", "side": "ask", "type": "limit", "price": "10000000000", "qty": "5"}"#,
        r#"{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "a2", "trader": "0xbbb", "side": "ask", "type": "limit", "price": "10100000000", "qty": "7"}"#,
        r#"{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "b1", "trader": "0xccc", "side": "bid", "type": "limit", "price": "10100000000", "qty": "9"}"#,
        r#"{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "b2", "trader": "0xaaa", "side": "bid", "type": "limit", "price": "10100000000", "qty": "1"}"#,
        r#"{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "b1", "price": "9900000000"}"#,
        r#"{"cmd": "cancel", "symbol": "BTC/USDC", "order_id": "b1"}"#,
        r#"{"cmd": "new_order", "symbol": "ETH/USDC", "order_id": "e1", "trader": "0xddd", "side": "bid", "type": "market", "qty": "3"}"#,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 5}"#,
        r#"{"cmd": "trades", "symbol": "BTC/USDC", "limit": 10}"#,
        r#"{"cmd": "ping"}"#,
    ];
    let run = || {
        let mut e = Engine::new();
        script
            .iter()
            .map(|line| e.handle_line(line).expect("response"))
            .collect::<Vec<_>>()
    };
    assert_eq!(run(), run());
}

#[test]
fn malformed_json_and_unknown_commands_error_without_stopping() {
    let mut e = Engine::new();
    let r = send(&mut e, "{not valid json");
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("invalid JSON"));

    let r = send(&mut e, r#"{"cmd": "frobnicate"}"#);
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("unknown command"));

    let r = send(&mut e, r#"{"no": "cmd"}"#);
    assert!(!is_ok(&r));

    // The engine keeps working.
    let r = send(&mut e, r#"{"cmd": "ping"}"#);
    assert!(is_ok(&r));
    let r = new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    assert!(is_ok(&r));
}

#[test]
fn duplicate_order_id_is_rejected_without_state_change() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    let r = new_order(
        &mut e,
        "o1",
        "0xbbb",
        "bid",
        "limit",
        Some("10000000000"),
        "5",
    );
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("duplicate order_id"));

    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert_eq!(book["asks"].as_array().unwrap().len(), 1);
    assert!(book["bids"].as_array().unwrap().is_empty());
}

#[test]
fn book_aggregates_levels_best_first_and_respects_depth() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "b1",
        "0xt1",
        "bid",
        "limit",
        Some("10000000000"),
        "1",
    );
    new_order(
        &mut e,
        "b2",
        "0xt2",
        "bid",
        "limit",
        Some("10000000000"),
        "2",
    );
    new_order(
        &mut e,
        "b3",
        "0xt3",
        "bid",
        "limit",
        Some("9900000000"),
        "5",
    );

    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 1}"#,
    );
    let bids = book["bids"].as_array().unwrap();
    assert_eq!(bids.len(), 1);
    assert_eq!(bids[0][0], "10000000000");
    assert_eq!(bids[0][1], "3"); // aggregated

    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 2}"#,
    );
    let bids = book["bids"].as_array().unwrap();
    assert_eq!(bids.len(), 2);
    assert_eq!(bids[0][0], "10000000000");
    assert_eq!(bids[1][0], "9900000000");

    // Unknown symbol yields an empty book, not an error.
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "NOPE/USDC", "depth": 5}"#,
    );
    assert!(is_ok(&book));
    assert!(book["bids"].as_array().unwrap().is_empty());
    assert!(book["asks"].as_array().unwrap().is_empty());
}

#[test]
fn trades_query_returns_newest_first_with_limit() {
    let mut e = Engine::new();
    new_order(
        &mut e,
        "a1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "9",
    );
    new_order(
        &mut e,
        "b1",
        "0xbbb",
        "bid",
        "limit",
        Some("10000000000"),
        "3",
    );
    new_order(
        &mut e,
        "b2",
        "0xccc",
        "bid",
        "limit",
        Some("10000000000"),
        "3",
    );
    new_order(
        &mut e,
        "b3",
        "0xddd",
        "bid",
        "limit",
        Some("10000000000"),
        "3",
    );

    let r = send(
        &mut e,
        r#"{"cmd": "trades", "symbol": "BTC/USDC", "limit": 2}"#,
    );
    assert!(is_ok(&r));
    let trades = r["trades"].as_array().unwrap();
    assert_eq!(trades.len(), 2);
    assert_eq!(trades[0]["trade_id"], 3);
    assert_eq!(trades[1]["trade_id"], 2);
    assert_eq!(trades[0]["ts"], 3);
    assert_eq!(trades[0]["maker_order"], "a1");

    let r = send(
        &mut e,
        r#"{"cmd": "trades", "symbol": "BTC/USDC", "limit": 50}"#,
    );
    assert_eq!(r["trades"].as_array().unwrap().len(), 3);
}

#[test]
fn invalid_inputs_are_rejected() {
    let mut e = Engine::new();
    // Limit order without price.
    let r = send(
        &mut e,
        r#"{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "o1", "trader": "0xaaa",
            "side": "bid", "type": "limit", "qty": "5"}"#,
    );
    assert!(!is_ok(&r));

    // Zero qty.
    let r = new_order(
        &mut e,
        "o1",
        "0xaaa",
        "bid",
        "limit",
        Some("10000000000"),
        "0",
    );
    assert!(!is_ok(&r));
    assert!(r["error"].as_str().unwrap().contains("positive"));

    // Non-numeric qty.
    let r = new_order(
        &mut e,
        "o1",
        "0xaaa",
        "bid",
        "limit",
        Some("10000000000"),
        "lots",
    );
    assert!(!is_ok(&r));

    // Bad side.
    let r = send(
        &mut e,
        r#"{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "o1", "trader": "0xaaa",
            "side": "sideways", "type": "limit", "price": "10000000000", "qty": "5"}"#,
    );
    assert!(!is_ok(&r));

    // Amend to zero qty is rejected and the order stays on the book.
    new_order(
        &mut e,
        "o1",
        "0xaaa",
        "ask",
        "limit",
        Some("10000000000"),
        "5",
    );
    let r = send(
        &mut e,
        r#"{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "o1", "qty": "0"}"#,
    );
    assert!(!is_ok(&r));
    let book = send(
        &mut e,
        r#"{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}"#,
    );
    assert_eq!(book["asks"][0][1], "5");
}

#[test]
fn blank_lines_get_no_response() {
    let mut e = Engine::new();
    assert!(e.handle_line("").is_none());
    assert!(e.handle_line("   \n").is_none());
}
