use crate::credential_scope::normalize_server;

fn entry(server: &str) -> Result<keyring::Entry, String> {
    let scope = normalize_server(server)?;
    keyring::Entry::new("com.isle.nasreader.session", &scope)
        .map_err(|_| "无法访问系统安全存储".to_owned())
}

#[tauri::command]
pub fn credentials_read(server: String) -> Result<Option<String>, String> {
    match entry(&server)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统安全存储，请重新登录".to_owned()),
    }
}

#[tauri::command]
pub fn credentials_write(server: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 65536 {
        return Err("登录会话无效".to_owned());
    }
    entry(&server)?
        .set_password(&value)
        .map_err(|_| "无法保存系统安全存储，请检查桌面密钥库权限".to_owned())
}

#[tauri::command]
pub fn credentials_clear(server: String) -> Result<(), String> {
    match entry(&server)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法移除系统安全存储中的会话".to_owned()),
    }
}
