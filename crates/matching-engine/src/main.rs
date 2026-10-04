//! OpenBook matching engine binary.
//!
//! Reads newline-delimited JSON requests from stdin and writes one
//! newline-delimited JSON response per request to stdout, strictly in order.
//! Requests are processed sequentially; every response line is flushed.

use openbook_engine::Engine;
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut engine = Engine::new();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if let Some(response) = engine.handle_line(&line) {
            if writeln!(out, "{response}").is_err() {
                break;
            }
            if out.flush().is_err() {
                break;
            }
        }
    }
}
