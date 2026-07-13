//! Provider-neutral thread title generation.
//!
//! The runtime uses [`LocalThreadTitleGenerator`] by default so a useful title
//! is available without credentials. Integrators can inject a richer
//! implementation (including one backed by any model provider); the local
//! generator remains the fallback when that implementation declines or fails.

use std::{fmt, panic::AssertUnwindSafe, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_util::FutureExt;

use crate::{
    domain::{ThreadId, TurnId},
    error::Result,
};

pub const DEFAULT_THREAD_TITLE: &str = "New thread";
pub const MAX_GENERATED_TITLE_CHARS: usize = 60;
pub const DEFAULT_PREFERRED_TITLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadTitleRequest {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub user_message: String,
    pub assistant_response: String,
    pub provider: String,
    pub model: String,
}

/// Extension point for provider-backed or application-specific title logic.
///
/// Returning `Ok(None)` asks the runtime to use its deterministic local
/// fallback. Errors are also isolated from the completed turn and fall back
/// locally.
#[async_trait]
pub trait ThreadTitleGenerator: fmt::Debug + Send + Sync {
    async fn generate(&self, request: &ThreadTitleRequest) -> Result<Option<String>>;
}

/// A fast deterministic title derived from the first user message.
#[derive(Debug, Clone, Copy, Default)]
pub struct LocalThreadTitleGenerator;

#[async_trait]
impl ThreadTitleGenerator for LocalThreadTitleGenerator {
    async fn generate(&self, request: &ThreadTitleRequest) -> Result<Option<String>> {
        Ok(normalize_title_candidate(&request.user_message)
            .or_else(|| normalize_title_candidate(&request.assistant_response)))
    }
}

/// Runs an injected generator first and retains the credential-free local
/// strategy as a safety net.
#[derive(Clone)]
pub struct FallbackThreadTitleGenerator {
    preferred: Arc<dyn ThreadTitleGenerator>,
    local: LocalThreadTitleGenerator,
    timeout: Duration,
}

impl FallbackThreadTitleGenerator {
    pub fn new(preferred: Arc<dyn ThreadTitleGenerator>) -> Self {
        Self::with_timeout(preferred, DEFAULT_PREFERRED_TITLE_TIMEOUT)
    }

    pub fn with_timeout(preferred: Arc<dyn ThreadTitleGenerator>, timeout: Duration) -> Self {
        Self {
            preferred,
            local: LocalThreadTitleGenerator,
            timeout,
        }
    }
}

impl fmt::Debug for FallbackThreadTitleGenerator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FallbackThreadTitleGenerator")
            .field("preferred", &self.preferred)
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ThreadTitleGenerator for FallbackThreadTitleGenerator {
    async fn generate(&self, request: &ThreadTitleRequest) -> Result<Option<String>> {
        let preferred = AssertUnwindSafe(self.preferred.generate(request)).catch_unwind();
        if let Ok(Ok(Ok(Some(candidate)))) = tokio::time::timeout(self.timeout, preferred).await {
            if let Some(title) = normalize_title_candidate(&candidate) {
                return Ok(Some(title));
            }
        }
        self.local.generate(request).await
    }
}

pub fn is_default_thread_title(title: &str) -> bool {
    let title = title.trim();
    title.is_empty() || title.eq_ignore_ascii_case(DEFAULT_THREAD_TITLE)
}

/// Normalizes both local input and provider-produced candidates so titles are
/// one line, safe to display, and bounded by Unicode scalar count rather than
/// UTF-8 bytes.
pub fn normalize_title_candidate(candidate: &str) -> Option<String> {
    let line = candidate
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !is_markdown_fence(line))?;
    let line = strip_markdown_prefix(line);
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .trim_end_matches(|character: char| {
            matches!(
                character,
                '.' | ',' | ';' | ':' | '!' | '?' | '。' | '，' | '；' | '：' | '！' | '？'
            )
        })
        .trim();
    if trimmed.is_empty() {
        return None;
    }

    let count = trimmed.chars().count();
    if count <= MAX_GENERATED_TITLE_CHARS {
        return Some(trimmed.to_owned());
    }

    let truncated = trimmed
        .chars()
        .take(MAX_GENERATED_TITLE_CHARS.saturating_sub(1))
        .collect::<String>();
    Some(format!("{}…", truncated.trim_end()))
}

fn is_markdown_fence(line: &str) -> bool {
    let line = line.trim();
    (line.starts_with("```") && line.trim_matches('`').trim().is_empty())
        || (line.starts_with("~~~") && line.trim_matches('~').trim().is_empty())
}

fn strip_markdown_prefix(mut line: &str) -> &str {
    line = line.trim_start_matches(|character: char| {
        character.is_whitespace() || matches!(character, '#' | '>' | '-' | '*' | '+')
    });

    if let Some((prefix, remainder)) = line.split_once(char::is_whitespace) {
        let numeric = prefix
            .trim_end_matches(['.', ')'])
            .chars()
            .all(|character| character.is_ascii_digit());
        if numeric && !prefix.is_empty() {
            return remainder.trim_start();
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KodyError;

    fn request(user_message: &str, assistant_response: &str) -> ThreadTitleRequest {
        ThreadTitleRequest {
            thread_id: ThreadId::new(),
            turn_id: TurnId::new(),
            user_message: user_message.into(),
            assistant_response: assistant_response.into(),
            provider: "echo".into(),
            model: "echo".into(),
        }
    }

    #[tokio::test]
    async fn local_titles_are_deterministic_and_clean_markdown() {
        let title = LocalThreadTitleGenerator
            .generate(&request(
                "\n## Implement OAuth callback handling!\nKeep existing sessions.",
                "ignored",
            ))
            .await
            .unwrap();

        assert_eq!(title.as_deref(), Some("Implement OAuth callback handling"));
    }

    #[test]
    fn title_limit_is_unicode_safe() {
        let input = "修".repeat(MAX_GENERATED_TITLE_CHARS + 5);
        let title = normalize_title_candidate(&input).unwrap();

        assert_eq!(title.chars().count(), MAX_GENERATED_TITLE_CHARS);
        assert!(title.ends_with('…'));
    }

    #[derive(Debug)]
    struct DecliningGenerator;

    #[async_trait]
    impl ThreadTitleGenerator for DecliningGenerator {
        async fn generate(&self, _request: &ThreadTitleRequest) -> Result<Option<String>> {
            Err(KodyError::Provider("title model unavailable".into()))
        }
    }

    #[tokio::test]
    async fn injected_generator_failures_use_the_local_fallback() {
        let generator = FallbackThreadTitleGenerator::new(Arc::new(DecliningGenerator));
        let title = generator
            .generate(&request("Fix the retry loop", "done"))
            .await
            .unwrap();

        assert_eq!(title.as_deref(), Some("Fix the retry loop"));
    }

    #[derive(Debug)]
    struct PanickingGenerator;

    #[async_trait]
    impl ThreadTitleGenerator for PanickingGenerator {
        async fn generate(&self, _request: &ThreadTitleRequest) -> Result<Option<String>> {
            panic!("provider adapter panic")
        }
    }

    #[tokio::test]
    async fn injected_generator_panics_use_the_local_fallback() {
        let generator = FallbackThreadTitleGenerator::new(Arc::new(PanickingGenerator));
        let title = generator
            .generate(&request("Preserve the completed turn", "done"))
            .await
            .unwrap();

        assert_eq!(title.as_deref(), Some("Preserve the completed turn"));
    }

    #[derive(Debug)]
    struct HangingGenerator;

    #[async_trait]
    impl ThreadTitleGenerator for HangingGenerator {
        async fn generate(&self, _request: &ThreadTitleRequest) -> Result<Option<String>> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn injected_generator_timeouts_use_the_local_fallback() {
        let generator = FallbackThreadTitleGenerator::with_timeout(
            Arc::new(HangingGenerator),
            Duration::from_millis(10),
        );
        let title = generator
            .generate(&request("Use the deterministic fallback", "done"))
            .await
            .unwrap();

        assert_eq!(title.as_deref(), Some("Use the deterministic fallback"));
    }
}
