use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

const REDACTED: &str = "<redacted>";

/// Redacts common credential shapes before process diagnostics can cross the
/// sidecar boundary. The raw stderr stream is never retained.
pub(crate) fn redact_text(input: &str) -> String {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            // Authorization headers and their bearer values.
            r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+",
            // JSON, TOML, dotenv, and log-style credential assignments.
            r#"(?i)((?:access|refresh|id)[_-]?token|api[_-]?key|client[_-]?secret|password|secret)([\"']?\s*[:=]\s*[\"']?)[^\"'\s,;}]+"#,
            // OpenAI-style secret keys.
            r"\bsk-[A-Za-z0-9_-]{8,}\b",
            // JWTs. Keep this after named assignments so the whole value is
            // replaced even when a log omits a field name.
            r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("credential redaction regex must compile"))
        .collect()
    });

    let mut output = input.to_owned();
    for (index, pattern) in patterns.iter().enumerate() {
        output = match index {
            0 => pattern
                .replace_all(&output, format!("$1{REDACTED}"))
                .into_owned(),
            1 => pattern
                .replace_all(&output, format!("$1$2{REDACTED}"))
                .into_owned(),
            _ => pattern.replace_all(&output, REDACTED).into_owned(),
        };
    }
    output
}

pub(crate) fn redact_rpc_error(
    mut error: crate::codex::types::RpcErrorPayload,
) -> crate::codex::types::RpcErrorPayload {
    error.message = redact_text(&error.message);
    if let Some(data) = error.data.as_mut() {
        redact_value(data);
    }
    error
}

/// Sanitizes only fields whose names are unambiguously credentials. Generic
/// tool arguments remain intact, while auth-related error payloads cannot leak
/// bearer material.
pub(crate) fn redact_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    normalized.as_str(),
                    "accesstoken"
                        | "refreshtoken"
                        | "idtoken"
                        | "apikey"
                        | "clientsecret"
                        | "password"
                        | "authorization"
                ) {
                    *child = Value::String(REDACTED.into());
                } else {
                    redact_value(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        Value::String(text) => *text = redact_text(text),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_named_bearer_key_and_jwt_credentials() {
        let input = concat!(
            "Authorization: Bearer abcdefghijklmnop ",
            "access_token=very-secret-token ",
            "sk-abcdefghijklmno ",
            "eyJabcdefgh.abcdefghijkl.abcdefghijkl"
        );
        let output = redact_text(input);
        assert!(!output.contains("abcdefghijklmnop"));
        assert!(!output.contains("very-secret-token"));
        assert!(!output.contains("sk-abcdefghijklmno"));
        assert!(!output.contains("eyJabcdefgh"));
        assert!(output.contains(REDACTED));
    }
}
