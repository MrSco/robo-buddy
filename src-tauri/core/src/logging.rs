//! Somewhere for `log::` to go. The crate has always depended on `log`, but nothing ever
//! installed a logger, so every `log::warn!` in the app was discarded. A loopback capture that
//! had gone deaf announced itself three times over and none of it reached the disk.
//!
//! Rust-side lines join the frontend's own diagnostics in `buddy.log`, which is the single file
//! the user sends back when something has gone wrong, in the same `<unix seconds> <text>` shape.

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Past this the file starts again, so a machine left running for weeks cannot fill the disk.
const MAX_BYTES: u64 = 200_000;

/// Append one timestamped line, rotating the file once it has grown too large. Shared with the
/// `append_log` command so both halves of the app write the same format into the same file.
pub fn append(path: &Path, line: &str) {
    if fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::remove_file(path);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{secs} {line}");
    }
}

/// A `static` rather than a boxed logger: `log::set_boxed_logger` sits behind a crate feature
/// this app does not otherwise need, and there is only ever one of these anyway.
static LOGGER: FileLogger = FileLogger { path: OnceLock::new(), write: Mutex::new(()) };

struct FileLogger {
    /// Set once by [`init`]; until then there is nowhere to write and lines are dropped.
    path: OnceLock<PathBuf>,
    /// Held across the whole append so two threads cannot interleave a line.
    write: Mutex<()>,
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let Some(path) = self.path.get() else {
            return;
        };
        let _guard = self.write.lock();
        append(
            path,
            &format!("{} [{}] {}", record.level().as_str().to_ascii_lowercase(), record.target(), record.args()),
        );
    }

    fn flush(&self) {}
}

/// Point `log::` at `buddy.log` in the app data directory. Called once, as early in setup as the
/// directory is known; failing to install a logger is not worth refusing to start over.
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    if LOGGER.path.set(dir.join("buddy.log")).is_err() {
        return;
    }
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("robo-buddy-log-test-{name}"));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn lines_are_appended_with_a_timestamp() {
        let path = temp_path("append");
        append(&path, "first");
        append(&path, "second");
        let body = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" first"), "{:?}", lines[0]);
        assert!(lines[1].ends_with(" second"), "{:?}", lines[1]);
        // A unix seconds stamp leads every line, so the log sorts and ages like the page's own.
        assert!(lines[0].split(' ').next().unwrap().parse::<u64>().unwrap() > 1_700_000_000);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn the_file_starts_again_once_it_is_too_large() {
        let path = temp_path("rotate");
        fs::write(&path, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        append(&path, "after the rotation");
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.ends_with("after the rotation\n"), "{body:?}");
        assert!(body.len() < 100, "old content survived: {} bytes", body.len());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_missing_directory_is_not_fatal() {
        let path = std::env::temp_dir().join("robo-buddy-no-such-dir").join("buddy.log");
        append(&path, "dropped on the floor");
        assert!(!path.exists());
    }

    /// `log::set_logger` may only be called once per process, so the installed-logger path is
    /// covered in a single test rather than one per assertion.
    #[test]
    fn installing_the_logger_sends_log_macros_to_the_file() {
        let dir = std::env::temp_dir().join("robo-buddy-log-test-init");
        let _ = fs::remove_dir_all(&dir);
        init(&dir);
        let path = dir.join("buddy.log");
        log::warn!("capture stopped");
        log::info!("device changed");
        log::debug!("too chatty to keep");
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("warn ["), "{body:?}");
        assert!(body.contains("capture stopped"), "{body:?}");
        assert!(body.contains("info ["), "{body:?}");
        assert!(body.contains("device changed"), "{body:?}");
        // Info is the floor: debug lines would bury the ones that matter.
        assert!(!body.contains("too chatty"), "{body:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
