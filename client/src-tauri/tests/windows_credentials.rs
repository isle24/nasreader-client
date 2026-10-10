#![cfg(target_os = "windows")]

use nasreader_client::credentials::{credentials_clear, credentials_read, credentials_write};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn session_persists_across_native_command_calls() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    // Reserved domain, unique OS-store entry, no network or real account.
    let server = format!("https://nasreader-ci-{}-{nonce}.invalid", std::process::id());
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) { let _ = credentials_clear(self.0.clone()); }
    }
    let _cleanup = Cleanup(server.clone());
    assert_eq!(credentials_read(server.clone()).unwrap(), None);
    let value = "nasreader-ci-ephemeral-session".to_owned();
    credentials_write(server.clone(), value.clone()).unwrap();
    assert_eq!(credentials_read(server.clone()).unwrap(), Some(value));
    credentials_clear(server.clone()).unwrap();
    assert_eq!(credentials_read(server).unwrap(), None);
}
