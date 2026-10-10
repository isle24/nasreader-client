pub fn normalize_server(server: &str) -> Result<String, String> {
    let parsed = url::Url::parse(server.trim()).map_err(|_| "服务端地址无效".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("仅支持不含凭据、查询或片段的 HTTP/HTTPS 服务地址".to_owned());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_credentials_to_normalized_server() {
        assert_eq!(
            normalize_server("http://NAS.local:18080/").unwrap(),
            "http://nas.local:18080"
        );
        assert_eq!(
            normalize_server("https://books.example.com/reader/").unwrap(),
            "https://books.example.com/reader"
        );
        assert_ne!(
            normalize_server("http://nas.local:18080").unwrap(),
            normalize_server("http://nas.local:18081").unwrap()
        );
    }
    #[test]
    fn rejects_credential_urls_and_non_http_schemes() {
        for server in [
            "file:///tmp/book",
            "javascript:alert(1)",
            "https://user:secret@books.local",
            "https://books.local?token=secret",
            "https://books.local/#access",
        ] {
            assert!(normalize_server(server).is_err());
        }
    }
}
