//! Offer to record when a call starts.
//!
//! When a call app starts to use the microphone, the TinyCloud One desktop app shows a small tile
//! at the edge of the screen: "Record this call", with "Start" and "Not now". This crate holds
//! everything about that offer that can be tested without a Mac:
//!
//! - [`apps`]: the call apps the offer knows, and how a process's bundle id maps to one.
//! - [`mic`]: which of those apps capture audio now, read from CoreAudio's process objects. On
//!   other platforms a stub that reports "unsupported".
//! - [`session`]: the state machine of one call: when to show the tile, when to hide it, what
//!   "Start" and "Not now" do.
//! - [`service`]: the watcher thread that scans every two seconds and drives the session.
//! - [`tile`]: the contract with the tile's page (window label, event, phases) and where the tile
//!   docks on the screen.
//!
//! Privacy: no audio is read. A scan reads the process list and whether each process captures;
//! for capturing processes only, the process id, the bundle id and whether it plays. A bundle id
//! that is not in the table is dropped at once: it is never stored, logged or returned.
//!
//! Everything except the macOS halves of [`mic`] and [`service::now`] is pure and runs on any
//! platform.

#![deny(unsafe_code)]

pub mod apps;
pub mod mic;
pub mod service;
pub mod session;
pub mod tile;
