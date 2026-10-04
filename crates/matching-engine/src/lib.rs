//! OpenBook matching engine.
//!
//! A deterministic central limit order book with price-time priority, spoken
//! over newline-delimited JSON (see the workspace PROTOCOL.md).
//!
//! All money is integer math: prices are quote-per-base scaled by 1e8 and
//! quantities are base-token smallest units, both parsed from decimal strings
//! into `u128`. Trade timestamps are logical per-book sequence numbers, so
//! replaying the same input sequence always yields the same output.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;

/// Quote token per one base token, scaled by 1e8 (see PROTOCOL.md).
pub const PRICE_SCALE: u128 = 100_000_000;

/// Order side: `Bid` buys base with quote, `Ask` sells base for quote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bid,
    Ask,
}

/// `Limit` orders may rest on the book; `Market` orders execute immediately
/// and any unfilled remainder is dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderType {
    Limit,
    Market,
}

/// A resting limit order.
#[derive(Debug, Clone)]
struct Order {
    id: String,
    trader: String,
    price: u128,
    qty: u128, // remaining, base smallest units
    seq: u64,  // per-book insertion counter: time priority within a level
}

/// Where a resting order lives, for direct cancel/amend lookup.
#[derive(Debug, Clone, Copy)]
struct OrderLoc {
    side: Side,
    price: u128,
}

/// An incoming order being matched. It is not on the book while matching.
struct Taker {
    id: String,
    trader: String,
    side: Side,
    qty: u128,           // remaining
    limit: Option<u128>, // None for market orders
}

/// A fill, kept per book for the `trades` query.
#[derive(Debug, Clone)]
pub struct Trade {
    pub trade_id: u64,
    pub price: u128,
    pub qty: u128,
    pub taker_order: String,
    pub maker_order: String,
    pub taker_trader: String,
    pub maker_trader: String,
    pub bid_trader: String,
    pub ask_trader: String,
    pub ts: u64,
}

/// Events emitted by engine commands, in the order they happened.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    OrderAccepted {
        order_id: String,
        symbol: String,
    },
    Trade {
        trade_id: u64,
        symbol: String,
        price: String,
        qty: String,
        taker_order: String,
        maker_order: String,
        taker_trader: String,
        maker_trader: String,
        bid_trader: String,
        ask_trader: String,
        ts: u64,
    },
    OrderCancelled {
        order_id: String,
        symbol: String,
        reason: String,
    },
}

impl Event {
    fn trade(symbol: &str, t: &Trade) -> Event {
        Event::Trade {
            trade_id: t.trade_id,
            symbol: symbol.to_string(),
            price: t.price.to_string(),
            qty: t.qty.to_string(),
            taker_order: t.taker_order.clone(),
            maker_order: t.maker_order.clone(),
            taker_trader: t.taker_trader.clone(),
            maker_trader: t.maker_trader.clone(),
            bid_trader: t.bid_trader.clone(),
            ask_trader: t.ask_trader.clone(),
            ts: t.ts,
        }
    }
}

/// Error type for invalid commands. Carries the message sent back as the
/// protocol `"error"` field; the engine state is never changed on error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    message: String,
}

impl EngineError {
    fn new(message: impl Into<String>) -> EngineError {
        EngineError {
            message: message.into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for EngineError {}

/// Parse a decimal integer string into `u128`. Rejects empty strings,
/// non-digit characters, and values above `u128::MAX`. No floats involved.
fn parse_amount(raw: &str) -> Result<u128, EngineError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(EngineError::new("amount is empty"));
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(EngineError::new(format!("invalid amount: {raw}")));
    }
    s.parse::<u128>()
        .map_err(|_| EngineError::new(format!("amount out of range: {raw}")))
}

/// `quote_amount = qty * price / PRICE_SCALE`, rounded down, denominated in
/// the quote token's smallest units. Returns `None` on overflow.
pub fn quote_amount(qty: u128, price: u128) -> Option<u128> {
    qty.checked_mul(price)?.checked_div(PRICE_SCALE)
}

/// One order book: bids and asks keyed by price level, each level a FIFO
/// queue of resting orders for time priority.
#[derive(Debug)]
struct Book {
    symbol: String,
    bids: BTreeMap<u128, VecDeque<Order>>,
    asks: BTreeMap<u128, VecDeque<Order>>,
    index: HashMap<String, OrderLoc>,
    next_seq: u64,
    next_trade_id: u64, // starts at 1
    next_ts: u64,       // logical timestamp, starts at 1
    trades: Vec<Trade>, // oldest first
}

impl Book {
    fn new(symbol: &str) -> Book {
        Book {
            symbol: symbol.to_string(),
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            index: HashMap::new(),
            next_seq: 0,
            next_trade_id: 1,
            next_ts: 1,
            trades: Vec::new(),
        }
    }

    fn levels_mut(&mut self, side: Side) -> &mut BTreeMap<u128, VecDeque<Order>> {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    /// Remove a resting order located by `loc`.
    fn remove_resting(&mut self, order_id: &str, loc: &OrderLoc) {
        let levels = self.levels_mut(loc.side);
        if let Some(level) = levels.get_mut(&loc.price) {
            if let Some(pos) = level.iter().position(|o| o.id == order_id) {
                level.remove(pos);
            }
            if level.is_empty() {
                levels.remove(&loc.price);
            }
        }
        self.index.remove(order_id);
    }

    /// Match `taker` against the opposite side with price-time priority.
    /// Emits self-trade cancellations and trades into `events`, in order.
    fn match_taker(&mut self, taker: &mut Taker, events: &mut Vec<Event>) {
        loop {
            if taker.qty == 0 {
                break;
            }
            let price = match taker.side {
                Side::Bid => match self.asks.iter().next() {
                    Some((&p, _)) if taker.limit.is_none_or(|limit| p <= limit) => p,
                    _ => break,
                },
                Side::Ask => match self.bids.iter().next_back() {
                    Some((&p, _)) if taker.limit.is_none_or(|limit| p >= limit) => p,
                    _ => break,
                },
            };
            self.match_level(taker, price, events);
        }
    }

    /// Match `taker` against every order at one price level, front to back.
    fn match_level(&mut self, taker: &mut Taker, price: u128, events: &mut Vec<Event>) {
        let levels = match taker.side {
            Side::Bid => &mut self.asks,
            Side::Ask => &mut self.bids,
        };
        let Some(level) = levels.get_mut(&price) else {
            return;
        };
        // Time priority: insertion sequence numbers must increase front to back.
        debug_assert!(
            level
                .iter()
                .zip(level.iter().skip(1))
                .all(|(a, b)| a.seq < b.seq),
            "time priority violated at price level"
        );
        while taker.qty > 0 {
            let Some(maker) = level.front() else {
                break;
            };
            if maker.trader == taker.trader {
                // Self-trade: cancel the resting order first, then continue.
                let cancelled = level.pop_front().expect("front was checked");
                self.index.remove(&cancelled.id);
                events.push(Event::OrderCancelled {
                    order_id: cancelled.id,
                    symbol: self.symbol.clone(),
                    reason: "self_trade".to_string(),
                });
                continue;
            }
            let maker_id = maker.id.clone();
            let maker_trader = maker.trader.clone();
            let fill = taker.qty.min(maker.qty);
            let maker_filled = fill == maker.qty;
            if maker_filled {
                level.pop_front();
                self.index.remove(&maker_id);
            } else if let Some(front) = level.front_mut() {
                front.qty -= fill;
            }
            taker.qty -= fill;

            let trade_id = self.next_trade_id;
            self.next_trade_id += 1;
            let ts = self.next_ts;
            self.next_ts += 1;
            let (bid_trader, ask_trader) = match taker.side {
                Side::Bid => (taker.trader.clone(), maker_trader.clone()),
                Side::Ask => (maker_trader.clone(), taker.trader.clone()),
            };
            let trade = Trade {
                trade_id,
                price,
                qty: fill,
                taker_order: taker.id.clone(),
                maker_order: maker_id,
                taker_trader: taker.trader.clone(),
                maker_trader,
                bid_trader,
                ask_trader,
                ts,
            };
            events.push(Event::trade(&self.symbol, &trade));
            self.trades.push(trade);
        }
        if level.is_empty() {
            levels.remove(&price);
        }
    }

    /// Aggregate resting quantity per price level, best price first.
    fn depth_side(&self, side: Side, depth: usize) -> Vec<[String; 2]> {
        let levels = match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        };
        match side {
            Side::Bid => levels
                .iter()
                .rev()
                .take(depth)
                .map(|(price, orders)| level_row(price, orders))
                .collect(),
            Side::Ask => levels
                .iter()
                .take(depth)
                .map(|(price, orders)| level_row(price, orders))
                .collect(),
        }
    }
}

fn level_row(price: &u128, orders: &VecDeque<Order>) -> [String; 2] {
    let total: u128 = orders.iter().map(|o| o.qty).sum();
    [price.to_string(), total.to_string()]
}

/// Parameters for [`Engine::place_order`].
pub struct NewOrder<'a> {
    pub symbol: &'a str,
    pub order_id: &'a str,
    pub trader: &'a str,
    pub side: Side,
    pub order_type: OrderType,
    pub price: Option<u128>, // required for limit, ignored for market
    pub qty: u128,           // base smallest units, must be positive
}

/// The matching engine: one [`Book`] per symbol.
#[derive(Debug, Default)]
pub struct Engine {
    books: HashMap<String, Book>,
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    fn book_mut(&mut self, symbol: &str) -> &mut Book {
        self.books
            .entry(symbol.to_string())
            .or_insert_with(|| Book::new(symbol))
    }

    /// Place an order: match it, then rest (limit) or drop (market) any
    /// remainder. Returns the events the placement caused, in order.
    pub fn place_order(&mut self, order: NewOrder<'_>) -> Result<Vec<Event>, EngineError> {
        require_non_empty("symbol", order.symbol)?;
        require_non_empty("order_id", order.order_id)?;
        require_non_empty("trader", order.trader)?;
        if order.qty == 0 {
            return Err(EngineError::new("qty must be positive"));
        }
        let limit = match order.order_type {
            OrderType::Limit => Some(
                order
                    .price
                    .ok_or_else(|| EngineError::new("limit order requires price"))?,
            ),
            OrderType::Market => None,
        };
        let book = self.book_mut(order.symbol);
        if book.index.contains_key(order.order_id) {
            return Err(EngineError::new(format!(
                "duplicate order_id: {}",
                order.order_id
            )));
        }
        let mut events = Vec::new();
        if order.order_type == OrderType::Limit {
            events.push(Event::OrderAccepted {
                order_id: order.order_id.to_string(),
                symbol: order.symbol.to_string(),
            });
        }
        let mut taker = Taker {
            id: order.order_id.to_string(),
            trader: order.trader.to_string(),
            side: order.side,
            qty: order.qty,
            limit,
        };
        book.match_taker(&mut taker, &mut events);
        if taker.qty > 0 {
            // Limit orders rest with their remaining quantity; market order
            // remainders are dropped silently and never rest.
            if order.order_type == OrderType::Limit {
                let price = limit.expect("limit price checked above");
                let seq = book.next_seq;
                book.next_seq += 1;
                book.index.insert(
                    order.order_id.to_string(),
                    OrderLoc {
                        side: order.side,
                        price,
                    },
                );
                book.levels_mut(order.side)
                    .entry(price)
                    .or_default()
                    .push_back(Order {
                        id: order.order_id.to_string(),
                        trader: order.trader.to_string(),
                        price,
                        qty: taker.qty,
                        seq,
                    });
            }
        }
        Ok(events)
    }

    /// Cancel a resting order. Unknown or already-filled ids are errors.
    pub fn cancel_order(
        &mut self,
        symbol: &str,
        order_id: &str,
    ) -> Result<Vec<Event>, EngineError> {
        let book = self
            .books
            .get_mut(symbol)
            .ok_or_else(|| unknown_order(order_id))?;
        let loc = book
            .index
            .get(order_id)
            .copied()
            .ok_or_else(|| unknown_order(order_id))?;
        book.remove_resting(order_id, &loc);
        Ok(vec![Event::OrderCancelled {
            order_id: order_id.to_string(),
            symbol: symbol.to_string(),
            reason: "cancelled".to_string(),
        }])
    }

    /// Amend price and/or qty of a resting order, implemented as cancel and
    /// replace: the replacement is a fresh order and loses time priority.
    pub fn amend_order(
        &mut self,
        symbol: &str,
        order_id: &str,
        price: Option<u128>,
        qty: Option<u128>,
    ) -> Result<Vec<Event>, EngineError> {
        if qty == Some(0) {
            return Err(EngineError::new("qty must be positive"));
        }
        // Snapshot the resting order before touching state, so validation
        // failures leave the book unchanged.
        let (side, trader, old_price, old_qty) = {
            let book = self
                .books
                .get(symbol)
                .ok_or_else(|| unknown_order(order_id))?;
            let loc = book
                .index
                .get(order_id)
                .copied()
                .ok_or_else(|| unknown_order(order_id))?;
            let levels = match loc.side {
                Side::Bid => &book.bids,
                Side::Ask => &book.asks,
            };
            let order = levels
                .get(&loc.price)
                .and_then(|level| level.iter().find(|o| o.id == order_id))
                .ok_or_else(|| EngineError::new("internal error: index out of sync"))?;
            (loc.side, order.trader.clone(), order.price, order.qty)
        };
        let new_price = price.unwrap_or(old_price);
        let new_qty = qty.unwrap_or(old_qty);
        if new_qty == 0 {
            return Err(EngineError::new("qty must be positive"));
        }
        let book = self.book_mut(symbol);
        let loc = book
            .index
            .get(order_id)
            .copied()
            .expect("order was present just above");
        book.remove_resting(order_id, &loc);
        let mut events = vec![Event::OrderCancelled {
            order_id: order_id.to_string(),
            symbol: symbol.to_string(),
            reason: "amend".to_string(),
        }];
        events.push(Event::OrderAccepted {
            order_id: order_id.to_string(),
            symbol: symbol.to_string(),
        });
        let mut taker = Taker {
            id: order_id.to_string(),
            trader,
            side,
            qty: new_qty,
            limit: Some(new_price),
        };
        book.match_taker(&mut taker, &mut events);
        if taker.qty > 0 {
            let seq = book.next_seq;
            book.next_seq += 1;
            book.index.insert(
                order_id.to_string(),
                OrderLoc {
                    side,
                    price: new_price,
                },
            );
            book.levels_mut(side)
                .entry(new_price)
                .or_default()
                .push_back(Order {
                    id: order_id.to_string(),
                    trader: taker.trader,
                    price: new_price,
                    qty: taker.qty,
                    seq,
                });
        }
        Ok(events)
    }
}

fn require_non_empty(field: &str, value: &str) -> Result<(), EngineError> {
    if value.trim().is_empty() {
        return Err(EngineError::new(format!("missing or empty field: {field}")));
    }
    Ok(())
}

fn unknown_order(order_id: &str) -> EngineError {
    EngineError::new(format!("unknown order: {order_id}"))
}

// ---------------------------------------------------------------------------
// Stdio JSON protocol
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct NewOrderReq {
    symbol: String,
    order_id: String,
    trader: String,
    side: Side,
    #[serde(rename = "type")]
    order_type: OrderType,
    price: Option<String>,
    qty: String,
}

#[derive(Deserialize)]
struct CancelReq {
    symbol: String,
    order_id: String,
}

#[derive(Deserialize)]
struct AmendReq {
    symbol: String,
    order_id: String,
    price: Option<String>,
    qty: Option<String>,
}

#[derive(Deserialize)]
struct BookReq {
    symbol: String,
    depth: Option<u32>,
}

#[derive(Deserialize)]
struct TradesReq {
    symbol: String,
    limit: Option<u32>,
}

#[derive(Serialize)]
struct TradeView {
    trade_id: u64,
    symbol: String,
    price: String,
    qty: String,
    taker_order: String,
    maker_order: String,
    taker_trader: String,
    maker_trader: String,
    bid_trader: String,
    ask_trader: String,
    ts: u64,
}

impl TradeView {
    fn new(symbol: &str, t: &Trade) -> TradeView {
        TradeView {
            trade_id: t.trade_id,
            symbol: symbol.to_string(),
            price: t.price.to_string(),
            qty: t.qty.to_string(),
            taker_order: t.taker_order.clone(),
            maker_order: t.maker_order.clone(),
            taker_trader: t.taker_trader.clone(),
            maker_trader: t.maker_trader.clone(),
            bid_trader: t.bid_trader.clone(),
            ask_trader: t.ask_trader.clone(),
            ts: t.ts,
        }
    }
}

/// One JSON response per request.
#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    events: Option<Vec<Event>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bids: Option<Vec<[String; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asks: Option<Vec<[String; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trades: Option<Vec<TradeView>>,
}

impl Response {
    fn ok_events(events: Vec<Event>) -> Response {
        Response {
            ok: true,
            error: None,
            events: Some(events),
            symbol: None,
            bids: None,
            asks: None,
            trades: None,
        }
    }

    fn err(message: impl Into<String>) -> Response {
        Response {
            ok: false,
            error: Some(message.into()),
            events: None,
            symbol: None,
            bids: None,
            asks: None,
            trades: None,
        }
    }
}

impl Engine {
    /// Handle one raw input line. Returns `None` for blank lines (no reply),
    /// otherwise the JSON response line.
    pub fn handle_line(&mut self, line: &str) -> Option<String> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return Some(Self::respond(Response::err(format!("invalid JSON: {e}")))),
        };
        let cmd = match value.get("cmd").and_then(Value::as_str) {
            Some(cmd) => cmd,
            None => return Some(Self::respond(Response::err("missing \"cmd\""))),
        };
        let response = match cmd {
            "new_order" => self.cmd_new_order(&value),
            "cancel" => self.cmd_cancel(&value),
            "amend" => self.cmd_amend(&value),
            "book" => self.cmd_book(&value),
            "trades" => self.cmd_trades(&value),
            "ping" => Response::ok_events(Vec::new()),
            _ => Response::err(format!("unknown command: {cmd}")),
        };
        Some(Self::respond(response))
    }

    fn respond(response: Response) -> String {
        serde_json::to_string(&response).unwrap_or_else(|_| {
            "{\"ok\":false,\"error\":\"response serialization failed\"}".to_string()
        })
    }

    fn decode<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, String> {
        serde_json::from_value(value.clone()).map_err(|e| format!("invalid request: {e}"))
    }

    fn cmd_new_order(&mut self, value: &Value) -> Response {
        let req: NewOrderReq = match Self::decode(value) {
            Ok(r) => r,
            Err(e) => return Response::err(e),
        };
        let qty = match parse_amount(&req.qty) {
            Ok(q) => q,
            Err(e) => return Response::err(e.to_string()),
        };
        let price = match req.price {
            Some(raw) => match parse_amount(&raw) {
                Ok(p) => Some(p),
                Err(e) => return Response::err(e.to_string()),
            },
            None => None,
        };
        match self.place_order(NewOrder {
            symbol: &req.symbol,
            order_id: &req.order_id,
            trader: &req.trader,
            side: req.side,
            order_type: req.order_type,
            price,
            qty,
        }) {
            Ok(events) => Response::ok_events(events),
            Err(e) => Response::err(e.to_string()),
        }
    }

    fn cmd_cancel(&mut self, value: &Value) -> Response {
        let req: CancelReq = match Self::decode(value) {
            Ok(r) => r,
            Err(e) => return Response::err(e),
        };
        match self.cancel_order(&req.symbol, &req.order_id) {
            Ok(events) => Response::ok_events(events),
            Err(e) => Response::err(e.to_string()),
        }
    }

    fn cmd_amend(&mut self, value: &Value) -> Response {
        let req: AmendReq = match Self::decode(value) {
            Ok(r) => r,
            Err(e) => return Response::err(e),
        };
        let price = match req.price {
            Some(raw) => match parse_amount(&raw) {
                Ok(p) => Some(p),
                Err(e) => return Response::err(e.to_string()),
            },
            None => None,
        };
        let qty = match req.qty {
            Some(raw) => match parse_amount(&raw) {
                Ok(q) => Some(q),
                Err(e) => return Response::err(e.to_string()),
            },
            None => None,
        };
        match self.amend_order(&req.symbol, &req.order_id, price, qty) {
            Ok(events) => Response::ok_events(events),
            Err(e) => Response::err(e.to_string()),
        }
    }

    fn cmd_book(&mut self, value: &Value) -> Response {
        let req: BookReq = match Self::decode(value) {
            Ok(r) => r,
            Err(e) => return Response::err(e),
        };
        if req.symbol.trim().is_empty() {
            return Response::err("missing or empty field: symbol");
        }
        let depth = req.depth.unwrap_or(20) as usize;
        let (bids, asks) = match self.books.get(&req.symbol) {
            Some(book) => (
                book.depth_side(Side::Bid, depth),
                book.depth_side(Side::Ask, depth),
            ),
            None => (Vec::new(), Vec::new()),
        };
        let mut response = Response::ok_events(Vec::new());
        response.symbol = Some(req.symbol);
        response.bids = Some(bids);
        response.asks = Some(asks);
        response
    }

    fn cmd_trades(&mut self, value: &Value) -> Response {
        let req: TradesReq = match Self::decode(value) {
            Ok(r) => r,
            Err(e) => return Response::err(e),
        };
        if req.symbol.trim().is_empty() {
            return Response::err("missing or empty field: symbol");
        }
        let limit = req.limit.unwrap_or(50) as usize;
        let trades: Vec<TradeView> = match self.books.get(&req.symbol) {
            Some(book) => book
                .trades
                .iter()
                .rev()
                .take(limit)
                .map(|t| TradeView::new(&book.symbol, t))
                .collect(),
            None => Vec::new(),
        };
        let mut response = Response::ok_events(Vec::new());
        response.symbol = Some(req.symbol);
        response.trades = Some(trades);
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_amount_accepts_plain_integers() {
        assert_eq!(parse_amount("0").unwrap(), 0);
        assert_eq!(parse_amount("42").unwrap(), 42);
        assert_eq!(parse_amount("000123").unwrap(), 123);
        assert_eq!(
            parse_amount("340282366920938463463374607431768211455").unwrap(),
            u128::MAX
        );
    }

    #[test]
    fn parse_amount_rejects_bad_input() {
        for bad in ["", "   ", "1.5", "-3", "+3", "0x10", "12a", "1_000"] {
            assert!(parse_amount(bad).is_err(), "should reject {bad:?}");
        }
        // one past u128::MAX
        assert!(parse_amount("340282366920938463463374607431768211456").is_err());
    }

    #[test]
    fn quote_amount_follows_protocol_formula() {
        // 3.0 base at 50000.0 quote, scaled: 3e18 * 50000e8 / 1e8 = 150000e18
        let qty = 3_000_000_000_000_000_000u128;
        let price = 5_000_000_000_000u128;
        assert_eq!(
            quote_amount(qty, price),
            Some(150_000_000_000_000_000_000_000)
        );
        // rounds down
        assert_eq!(quote_amount(1, 1), Some(0));
        assert_eq!(quote_amount(1, PRICE_SCALE), Some(1));
        // overflow is reported, not wrapped
        assert_eq!(quote_amount(u128::MAX, 2), None);
    }
}
