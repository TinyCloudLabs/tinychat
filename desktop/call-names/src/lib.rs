//! Display names of the people in a call, read from the meeting app's window.
//!
//! Phase 1 of "names in the call" for the TinyCloud One desktop recorder. While a recording runs,
//! and only if the user opted in, the app reads the meeting window (Google Meet in a Chromium
//! browser, Zoom) through the macOS Accessibility API and keeps the display names it finds.
//!
//! - [`tree`]: the Accessibility node model and the lazy [`tree::Source`] a reading walks.
//! - [`rules`]: the reading rules, as JSON data (`rules/embedded.json`).
//! - [`extract`]: one app's rules over one window, giving names with a `self` flag.
//! - [`names`]: cleaning and caps; a `Debug` that never prints a name.
//! - [`roster`]: the people of one recording with stable ids, and the `call_participants` JSON.
//! - [`session`]: one tick, with its node, depth and time budget; an overrun discards the tick.
//! - [`ax`]: the macOS reader (Accessibility API); on other platforms a stub that reports
//!   "unsupported".
//!
//! Everything except the macOS half of [`ax`] is pure and runs on any platform.

#![deny(unsafe_code)]

pub mod ax;
pub mod extract;
pub mod names;
pub mod roster;
pub mod rules;
pub mod service;
pub mod session;
pub mod tree;
