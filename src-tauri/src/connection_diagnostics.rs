//! Connection credentials belong in storage or an explicitly requested terminal,
//! never in the startup journal or diagnostic files.
use serde_json::Value;
use std::io::Write;
use std::path::Path;

pub(crate) fn write_banner(
    output: &mut impl Write,
    stdout_is_terminal: bool,
    data_dir: &Path,
    result: &Value,
    print_connect_link: bool,
) -> Result<(), String> {
    // Check before writing anything, including when called outside the CLI.
    if print_connect_link && !stdout_is_terminal {
        return Err("--print-connect-link requires stdout to be a terminal".into());
    }
    let field = |key: &str| {
        result
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("remote server result missing {key}"))
    };
    let port = result
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "remote server result missing port".to_string())?;
    let host = field("boundHost")?;
    let bind = field("bindInterface")?;
    let fingerprint = field("fingerprint")?;
    // Build the normal banner without ever interpolating the token.
    let banner = format!(
        "\nbat-server ready\n  url:         wss://{host}:{port}\n  bind:        {bind}\n  token:       (hidden — stored in {})\n  fingerprint: {fingerprint}\n  data-dir:    {}\n  connect:     wss://{host}:{port}?token=[REDACTED]&fp={}\n",
        data_dir.join("server-token.enc.json").display(),
        data_dir.display(),
        encode_query_component(fingerprint),
    );
    output
        .write_all(redact(&banner).as_bytes())
        .map_err(|_| "could not write startup banner".to_string())?;
    if print_connect_link {
        // This is the only deliberate credential output, guarded by both the
        // user's explicit flag and the actual stdout terminal check.
        let token = field("token")?;
        writeln!(
            output,
            "  full-connect: wss://{host}:{port}?token={}&fp={}",
            encode_query_component(token),
            encode_query_component(fingerprint)
        )
        .map_err(|_| "could not write connection link".to_string())?;
    }
    Ok(())
}

pub(crate) fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

/// Sanitize reflected connection URLs and credential fields in error/debug
/// messages before they reach stderr or debug.log. Never modify wire payloads.
pub(crate) fn redact(message: &str) -> String {
    let mut result = message.to_string();
    // Include JSON/debug fields as well as URLs/legacy command-line syntax.
    for marker in ["token=", "\"token\":", "\"remotetoken\":"] {
        let mut cursor = 0;
        loop {
            let lower = result.to_ascii_lowercase();
            let Some(relative) = lower[cursor..].find(marker) else {
                break;
            };
            let start = cursor + relative + marker.len();
            let rest = &result[start..];
            let whitespace = rest.len() - rest.trim_start().len();
            let value_start = start + whitespace;
            let quote = result[value_start..]
                .chars()
                .next()
                .filter(|ch| matches!(ch, '\'' | '"'));
            let value_start = value_start + quote.map_or(0, char::len_utf8);
            let mut escaped = false;
            let end = result[value_start..]
                .char_indices()
                .find(|(_, ch)| match quote {
                    Some(quote) => {
                        if escaped {
                            escaped = false;
                            false
                        } else if *ch == '\\' {
                            escaped = true;
                            false
                        } else {
                            *ch == quote
                        }
                    }
                    None => {
                        ch.is_whitespace()
                            || matches!(ch, '&' | '#' | '"' | '\'' | '<' | '>' | ',' | '}')
                    }
                })
                .map_or(result.len(), |(offset, _)| value_start + offset);
            result.replace_range(value_start..end, "[REDACTED]");
            cursor = value_start + "[REDACTED]".len();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server_result() -> Value {
        json!({"port":9876, "boundHost":"example.invalid", "bindInterface":"localhost",
            "token":"fixture-only &/秘密", "fingerprint":"AA:BB"})
    }

    #[test]
    fn default_banner_hides_raw_and_encoded_token_for_terminal_and_journal() {
        for terminal in [false, true] {
            let mut bytes = Vec::new();
            write_banner(
                &mut bytes,
                terminal,
                Path::new("/fixture/data"),
                &server_result(),
                false,
            )
            .unwrap();
            let text = String::from_utf8(bytes).unwrap();
            assert!(!text.contains("fixture-only"));
            assert!(!text.contains(&encode_query_component("fixture-only &/秘密")));
            assert!(text.contains("hidden — stored in"));
            assert!(text.contains("server-token.enc.json"));
            assert!(text.contains("?token=[REDACTED]&fp=AA%3ABB"));
        }
    }

    #[test]
    fn full_link_requires_both_explicit_opt_in_and_terminal_stdout() {
        let mut output = Vec::new();
        assert!(write_banner(
            &mut output,
            false,
            Path::new("/fixture"),
            &server_result(),
            true
        )
        .is_err());
        assert!(output.is_empty());
        write_banner(
            &mut output,
            true,
            Path::new("/fixture"),
            &server_result(),
            true,
        )
        .unwrap();
        assert!(String::from_utf8(output).unwrap().contains(
            "full-connect: wss://example.invalid:9876?token=fixture-only%20%26%2F%E7%A7%98%E5%AF%86&fp=AA%3ABB"));
    }

    #[test]
    fn redacts_urls_and_credential_fields_in_errors_without_losing_context() {
        let cases = [
            (
                "failed wss://example.invalid?token=fixture-secret&fp=AA:BB",
                "failed wss://example.invalid?token=[REDACTED]&fp=AA:BB",
            ),
            (
                "--TOKEN=fixture-secret invalid",
                "--TOKEN=[REDACTED] invalid",
            ),
            (
                r#"auth {"token": "fixture-secret", "remoteToken":"another-secret"}"#,
                r#"auth {"token": "[REDACTED]", "remoteToken":"[REDACTED]"}"#,
            ),
            (
                r#"{"token":"fixture\"secret"}"#,
                r#"{"token":"[REDACTED]"}"#,
            ),
            ("Invalid token", "Invalid token"),
            (
                "錯誤 token=fixture-secret&fp=AA",
                "錯誤 token=[REDACTED]&fp=AA",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected);
            assert_eq!(redact(expected), expected);
        }
    }
}
