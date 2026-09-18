//! The parts of Robo Buddy that are just logic.
//!
//! Everything here is free of Tauri, and of Windows, on purpose. The app crate links a webview,
//! a tray icon and the common controls, and its test harness inherits all of it: without the
//! manifest that only the app binary gets, that harness cannot even start, so unit tests written
//! beside it never ran. Logic that is worth a test lives here instead, where `cargo test` links
//! almost nothing and finishes in about a second.

pub mod idle_episode;
pub mod logging;
