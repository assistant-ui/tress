//! tress — a tiny coding agent whose session is a thread.
//!
//! The crate is the agent core: an [`engine::Engine`] drives a
//! [`provider::Provider`] over a [`tools::Tools`] surface and reports
//! [`engine::Event`]s. Nothing in the core touches the terminal, so the same
//! engine backs the `tress` binary, a browser build, and embedded hosts.

pub mod engine;
pub mod provider;
pub mod tools;

pub use engine::{Approval, Engine, Event};
pub use provider::{Anthropic, Provider};
pub use tools::{NativeTools, ToolOutcome, Tools};
