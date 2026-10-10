#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use nasreader_client::credentials;
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            credentials::credentials_read,
            credentials::credentials_write,
            credentials::credentials_clear
        ])
        .run(tauri::generate_context!())
        .expect("nasReader runtime failed");
}
