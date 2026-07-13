use std::{env, fmt, time::Duration};

use async_trait::async_trait;
use reqwest::{header, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CodyError, Result};

use super::{
    emit_response, AuthState, FinishReason, ModelContent, ModelDeltaSink, ModelMessage,
    ModelProvider, ModelRequest, ModelResponse, ModelRole, ModelUsage, ProviderCapabilities,
    ProviderDescriptor, ToolDefinition,
};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Configuration for OpenAI and services implementing the non-streaming
/// `/chat/completions` API.
#[derive(Clone)]
pub struct OpenAiCompatibleConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub default_model: Option<String>,
    pub configured_models: Vec<String>,
    pub organization: Option<String>,
    pub project: Option<String>,
    pub timeout: Duration,
}

impl fmt::Debug for OpenAiCompatibleConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiCompatibleConfig")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("default_model", &self.default_model)
            .field("configured_models", &self.configured_models)
            .field("organization", &self.organization)
            .field("project", &self.project)
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl Default for OpenAiCompatibleConfig {
    fn default() -> Self {
        Self {
            id: "openai".into(),
            display_name: "OpenAI compatible".into(),
            base_url: DEFAULT_BASE_URL.into(),
            api_key: None,
            default_model: None,
            configured_models: Vec::new(),
            organization: None,
            project: None,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }
}

impl OpenAiCompatibleConfig {
    pub fn new(id: impl Into<String>, base_url: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            base_url: base_url.into(),
            ..Self::default()
        }
    }

    /// Loads the optional built-in provider configuration.
    ///
    /// `CODY_OPENAI_*` variables take precedence over their conventional
    /// `OPENAI_*` counterparts. A configuration is returned when at least one
    /// relevant variable is present, which supports local services that do not
    /// require an API key.
    ///
    /// Supported variables:
    /// - `CODY_OPENAI_PROVIDER_ID`
    /// - `CODY_OPENAI_BASE_URL` / `OPENAI_BASE_URL`
    /// - `CODY_OPENAI_API_KEY` / `OPENAI_API_KEY`
    /// - `CODY_OPENAI_MODEL` / `OPENAI_MODEL`
    /// - `CODY_OPENAI_ORGANIZATION` / `OPENAI_ORGANIZATION`
    /// - `CODY_OPENAI_PROJECT` / `OPENAI_PROJECT`
    /// - `CODY_OPENAI_TIMEOUT_SECS`
    pub fn from_env() -> Result<Option<Self>> {
        let id = optional_env("CODY_OPENAI_PROVIDER_ID")?;
        let cody_base_url = optional_env("CODY_OPENAI_BASE_URL")?;
        let standard_base_url = optional_env("OPENAI_BASE_URL")?;
        let cody_api_key = optional_env("CODY_OPENAI_API_KEY")?;
        let standard_api_key = optional_env("OPENAI_API_KEY")?;
        let cody_model = optional_env("CODY_OPENAI_MODEL")?;
        let standard_model = optional_env("OPENAI_MODEL")?;
        let cody_organization = optional_env("CODY_OPENAI_ORGANIZATION")?;
        let standard_organization = optional_env("OPENAI_ORGANIZATION")?;
        let cody_project = optional_env("CODY_OPENAI_PROJECT")?;
        let standard_project = optional_env("OPENAI_PROJECT")?;
        let timeout = optional_env("CODY_OPENAI_TIMEOUT_SECS")?;

        let configured = id.is_some()
            || cody_base_url.is_some()
            || standard_base_url.is_some()
            || cody_api_key.is_some()
            || standard_api_key.is_some()
            || cody_model.is_some()
            || standard_model.is_some()
            || cody_organization.is_some()
            || standard_organization.is_some()
            || cody_project.is_some()
            || standard_project.is_some()
            || timeout.is_some();
        if !configured {
            return Ok(None);
        }

        let timeout = timeout
            .map(|value| {
                value.parse::<u64>().map_err(|_| {
                    CodyError::InvalidInput(
                        "CODY_OPENAI_TIMEOUT_SECS must be a positive integer".into(),
                    )
                })
            })
            .transpose()?
            .unwrap_or(DEFAULT_TIMEOUT_SECS);
        if timeout == 0 {
            return Err(CodyError::InvalidInput(
                "CODY_OPENAI_TIMEOUT_SECS must be greater than zero".into(),
            ));
        }

        let id = id.unwrap_or_else(|| "openai".into());
        Ok(Some(Self {
            display_name: id.clone(),
            id,
            base_url: cody_base_url
                .or(standard_base_url)
                .unwrap_or_else(|| DEFAULT_BASE_URL.into()),
            api_key: cody_api_key.or(standard_api_key),
            default_model: cody_model.or(standard_model),
            configured_models: Vec::new(),
            organization: cody_organization.or(standard_organization),
            project: cody_project.or(standard_project),
            timeout: Duration::from_secs(timeout),
        }))
    }
}

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    config: OpenAiCompatibleConfig,
    endpoint: Url,
    client: Client,
}

impl fmt::Debug for OpenAiCompatibleProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiCompatibleProvider")
            .field("config", &self.config)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl OpenAiCompatibleProvider {
    pub fn new(config: OpenAiCompatibleConfig) -> Result<Self> {
        validate_config(&config)?;
        let endpoint = completion_endpoint(&config.base_url)?;
        let client = Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| {
                CodyError::Provider(format!("failed to build OpenAI HTTP client: {error}"))
            })?;
        Ok(Self {
            config,
            endpoint,
            client,
        })
    }

    pub fn config(&self) -> &OpenAiCompatibleConfig {
        &self.config
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    fn resolve_model<'a>(&'a self, request: &'a ModelRequest) -> Result<&'a str> {
        if !request.model.trim().is_empty() {
            return Ok(request.model.as_str());
        }
        self.config
            .default_model
            .as_deref()
            .filter(|model| !model.trim().is_empty())
            .ok_or_else(|| {
                CodyError::InvalidInput(
                    "model must be specified in the request or provider configuration".into(),
                )
            })
    }

    /// Removes the configured credential from any provider-controlled error
    /// text before it can enter logs, events, or an RPC response.
    fn redact(&self, value: &str) -> String {
        match self
            .config
            .api_key
            .as_deref()
            .filter(|secret| !secret.is_empty())
        {
            Some(secret) => value.replace(secret, "[REDACTED]"),
            None => value.to_owned(),
        }
    }

    fn provider_error(&self, message: impl Into<String>) -> CodyError {
        CodyError::Provider(self.redact(&message.into()))
    }

    fn redact_error(&self, error: CodyError) -> CodyError {
        match error {
            CodyError::Provider(message) => self.provider_error(message),
            other => other,
        }
    }
}

#[async_trait]
impl ModelProvider for OpenAiCompatibleProvider {
    fn id(&self) -> &str {
        &self.config.id
    }

    fn default_model(&self) -> Option<&str> {
        self.config.default_model.as_deref()
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.config.id.clone(),
            display_name: self.config.display_name.clone(),
            kind: "openai_chat_completions".into(),
            auth: if self.config.api_key.is_some() {
                AuthState::Configured
            } else {
                AuthState::Unknown
            },
            capabilities: ProviderCapabilities {
                streaming: false,
                reasoning: false,
                tools: true,
                model_catalog: false,
                custom_models: true,
            },
            default_model: self.config.default_model.clone(),
        }
    }

    async fn list_models(&self) -> Result<Vec<super::ModelDescriptor>> {
        let mut models = self.config.configured_models.clone();
        if let Some(default) = self.config.default_model.as_ref() {
            models.push(default.clone());
        }
        models.retain(|model| !model.trim().is_empty());
        models.sort();
        models.dedup();
        Ok(models
            .into_iter()
            .map(|model| {
                let is_default = self.config.default_model.as_deref() == Some(model.as_str());
                super::ModelDescriptor::new(model).with_default(is_default)
            })
            .collect())
    }

    async fn complete(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse> {
        let model = self.resolve_model(&request)?;
        let wire_request = OpenAiRequest {
            model: model.to_owned(),
            messages: encode_messages(&request.messages)?,
            tools: encode_tools(&request.tools),
            temperature: request.temperature,
            max_tokens: request.max_output_tokens,
            stream: false,
        };

        let mut builder = self
            .client
            .post(self.endpoint.clone())
            .header(header::ACCEPT, "application/json")
            .json(&wire_request);
        if let Some(api_key) = self.config.api_key.as_deref() {
            builder = builder.bearer_auth(api_key);
        }
        if let Some(organization) = self.config.organization.as_deref() {
            builder = builder.header("OpenAI-Organization", organization);
        }
        if let Some(project) = self.config.project.as_deref() {
            builder = builder.header("OpenAI-Project", project);
        }

        let mut http_response = builder.send().await.map_err(|error| {
            self.provider_error(format!(
                "OpenAI-compatible request to {} failed: {error}",
                self.endpoint
            ))
        })?;
        let status = http_response.status();
        if http_response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(CodyError::Provider(format!(
                "OpenAI-compatible response exceeds {MAX_RESPONSE_BYTES} bytes"
            )));
        }
        let mut body = Vec::new();
        while let Some(chunk) = http_response.chunk().await.map_err(|error| {
            self.provider_error(format!(
                "failed to read OpenAI-compatible response body: {error}"
            ))
        })? {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(CodyError::Provider(format!(
                    "OpenAI-compatible response exceeds {MAX_RESPONSE_BYTES} bytes"
                )));
            }
            body.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(body).map_err(|error| {
            self.provider_error(format!(
                "OpenAI-compatible response is not valid UTF-8: {error}"
            ))
        })?;

        if !status.is_success() {
            return Err(self.provider_error(format!(
                "OpenAI-compatible API returned {status}: {}",
                api_error_message(&body)
            )));
        }

        let wire_response: OpenAiResponse = serde_json::from_str(&body).map_err(|error| {
            self.provider_error(format!(
                "invalid OpenAI-compatible response: {error}; body: {}",
                truncate(&body, 2_000)
            ))
        })?;
        let response = decode_response(wire_response).map_err(|error| self.redact_error(error))?;
        emit_response(delta_sink, &response)
            .await
            .map_err(|error| self.redact_error(error))?;
        Ok(response)
    }
}

fn validate_config(config: &OpenAiCompatibleConfig) -> Result<()> {
    if config.id.trim().is_empty() {
        return Err(CodyError::InvalidInput(
            "OpenAI-compatible provider id must not be empty".into(),
        ));
    }
    if config.id != config.id.trim() {
        return Err(CodyError::InvalidInput(
            "OpenAI-compatible provider id must not contain leading or trailing whitespace".into(),
        ));
    }
    if config.base_url.trim().is_empty() {
        return Err(CodyError::InvalidInput(
            "OpenAI-compatible base URL must not be empty".into(),
        ));
    }
    if config.timeout.is_zero() {
        return Err(CodyError::InvalidInput(
            "OpenAI-compatible timeout must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn completion_endpoint(base_url: &str) -> Result<Url> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let endpoint = if trimmed.ends_with("/chat/completions") {
        trimmed.to_owned()
    } else {
        format!("{trimmed}/chat/completions")
    };
    Url::parse(&endpoint).map_err(|error| {
        CodyError::InvalidInput(format!(
            "invalid OpenAI-compatible base URL '{base_url}': {error}"
        ))
    })
}

fn optional_env(key: &str) -> Result<Option<String>> {
    match env::var(key) {
        Ok(value) => {
            let value = value.trim().to_owned();
            Ok((!value.is_empty()).then_some(value))
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(CodyError::InvalidInput(format!(
            "{key} contains non-Unicode data"
        ))),
    }
}

#[derive(Debug, Serialize)]
struct OpenAiRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<OpenAiTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAiToolCallRequest>>,
}

impl OpenAiMessage {
    fn plain(role: &'static str, content: String) -> Self {
        Self {
            role,
            content: Some(content),
            tool_call_id: None,
            name: None,
            tool_calls: None,
        }
    }
}

#[derive(Debug, Serialize)]
struct OpenAiTool {
    #[serde(rename = "type")]
    kind: &'static str,
    function: OpenAiFunctionDefinition,
}

#[derive(Debug, Serialize)]
struct OpenAiFunctionDefinition {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Debug, Serialize)]
struct OpenAiToolCallRequest {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: OpenAiFunctionCallRequest,
}

#[derive(Debug, Serialize)]
struct OpenAiFunctionCallRequest {
    name: String,
    arguments: String,
}

fn encode_tools(tools: &[ToolDefinition]) -> Option<Vec<OpenAiTool>> {
    (!tools.is_empty()).then(|| {
        tools
            .iter()
            .map(|tool| OpenAiTool {
                kind: "function",
                function: OpenAiFunctionDefinition {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.input_schema.clone(),
                },
            })
            .collect()
    })
}

fn encode_messages(messages: &[ModelMessage]) -> Result<Vec<OpenAiMessage>> {
    let mut encoded = Vec::new();
    for message in messages {
        match message.role {
            ModelRole::System | ModelRole::User => {
                let role = if message.role == ModelRole::System {
                    "system"
                } else {
                    "user"
                };
                let text = text_only(message, role)?;
                encoded.push(OpenAiMessage::plain(role, text));
            }
            ModelRole::Assistant => encoded.push(encode_assistant_message(message)?),
            ModelRole::Tool => encode_tool_messages(message, &mut encoded)?,
        }
    }
    Ok(encoded)
}

fn text_only(message: &ModelMessage, role: &str) -> Result<String> {
    let mut texts = Vec::new();
    for content in &message.content {
        match content {
            ModelContent::Text { text } => texts.push(text.as_str()),
            _ => {
                return Err(CodyError::InvalidInput(format!(
                    "{role} model messages may only contain text"
                )))
            }
        }
    }
    Ok(texts.join("\n"))
}

fn encode_assistant_message(message: &ModelMessage) -> Result<OpenAiMessage> {
    let mut texts = Vec::new();
    let mut tool_calls = Vec::new();
    for content in &message.content {
        match content {
            ModelContent::Text { text } => texts.push(text.as_str()),
            ModelContent::ToolCall {
                id,
                name,
                arguments,
            } => tool_calls.push(OpenAiToolCallRequest {
                id: id.clone(),
                kind: "function",
                function: OpenAiFunctionCallRequest {
                    name: name.clone(),
                    arguments: serde_json::to_string(arguments)?,
                },
            }),
            ModelContent::ToolResult { .. } => {
                return Err(CodyError::InvalidInput(
                    "assistant model messages cannot contain tool results".into(),
                ))
            }
        }
    }
    Ok(OpenAiMessage {
        role: "assistant",
        content: (!texts.is_empty()).then(|| texts.join("\n")),
        tool_call_id: None,
        name: None,
        tool_calls: (!tool_calls.is_empty()).then_some(tool_calls),
    })
}

fn encode_tool_messages(message: &ModelMessage, encoded: &mut Vec<OpenAiMessage>) -> Result<()> {
    if message.content.is_empty() {
        return Err(CodyError::InvalidInput(
            "tool model messages must contain at least one tool result".into(),
        ));
    }

    for content in &message.content {
        match content {
            ModelContent::ToolResult {
                tool_call_id,
                name,
                content,
                ..
            } => encoded.push(OpenAiMessage {
                role: "tool",
                content: Some(content.clone()),
                tool_call_id: Some(tool_call_id.clone()),
                name: Some(name.clone()),
                tool_calls: None,
            }),
            _ => {
                return Err(CodyError::InvalidInput(
                    "tool model messages may only contain tool results".into(),
                ))
            }
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponseMessage {
    #[serde(default)]
    content: Value,
    tool_calls: Option<Vec<OpenAiToolCallResponse>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCallResponse {
    id: String,
    function: OpenAiFunctionCallResponse,
}

#[derive(Debug, Deserialize)]
struct OpenAiFunctionCallResponse {
    name: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

fn decode_response(response: OpenAiResponse) -> Result<ModelResponse> {
    let choice = response.choices.into_iter().next().ok_or_else(|| {
        CodyError::Provider("OpenAI-compatible response contained no choices".into())
    })?;
    let mut content = Vec::new();
    if let Some(text) = decode_text_content(choice.message.content)? {
        if !text.is_empty() {
            content.push(ModelContent::Text { text });
        }
    }
    for call in choice.message.tool_calls.unwrap_or_default() {
        content.push(ModelContent::ToolCall {
            id: call.id.clone(),
            name: call.function.name,
            arguments: decode_tool_arguments(call.function.arguments, &call.id)?,
        });
    }

    let inferred_tool_calls = content
        .iter()
        .any(|part| matches!(part, ModelContent::ToolCall { .. }));
    let finish_reason =
        choice
            .finish_reason
            .map(decode_finish_reason)
            .unwrap_or(if inferred_tool_calls {
                FinishReason::ToolCalls
            } else {
                FinishReason::Stop
            });
    let usage = response.usage.map(|usage| {
        let total_tokens = if usage.total_tokens == 0 {
            usage.prompt_tokens.saturating_add(usage.completion_tokens)
        } else {
            usage.total_tokens
        };
        ModelUsage {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens,
        }
    });

    Ok(ModelResponse {
        content,
        finish_reason,
        usage,
    })
}

fn decode_text_content(content: Value) -> Result<Option<String>> {
    match content {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text)),
        Value::Array(parts) => {
            let texts = parts
                .into_iter()
                .filter_map(|part| {
                    let text = part.get("text")?;
                    match text {
                        Value::String(text) => Some(text.clone()),
                        Value::Object(object) => object
                            .get("value")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>();
            Ok((!texts.is_empty()).then(|| texts.join("")))
        }
        other => Err(CodyError::Provider(format!(
            "unsupported OpenAI-compatible message content: {other}"
        ))),
    }
}

fn decode_tool_arguments(arguments: Value, call_id: &str) -> Result<Value> {
    match arguments {
        Value::String(arguments) if arguments.trim().is_empty() => {
            Ok(Value::Object(Default::default()))
        }
        Value::String(arguments) => serde_json::from_str(&arguments).map_err(|error| {
            CodyError::Provider(format!(
                "tool call '{call_id}' returned invalid JSON arguments: {error}"
            ))
        }),
        other => Ok(other),
    }
}

fn decode_finish_reason(reason: String) -> FinishReason {
    match reason.as_str() {
        "stop" => FinishReason::Stop,
        "tool_calls" | "function_call" => FinishReason::ToolCalls,
        "length" | "max_tokens" => FinishReason::Length,
        "content_filter" => FinishReason::ContentFilter,
        _ => FinishReason::Other(reason),
    }
}

fn api_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| truncate(body, 2_000))
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };

    async fn spawn_mock_response(
        status: u16,
        reason: &str,
        body: String,
    ) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let reason = reason.to_owned();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_http_request(&mut socket).await;
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        (format!("http://{address}/v1"), task)
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4_096];
        let mut expected = None;
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..read]);
            if expected.is_none() {
                if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or_default();
                    expected = Some(header_end + 4 + content_length);
                }
            }
            if expected.is_some_and(|length| request.len() >= length) {
                return;
            }
        }
    }

    fn provider_for_test(base_url: String, secret: &str) -> OpenAiCompatibleProvider {
        let mut config = OpenAiCompatibleConfig::new("compatible-test", base_url);
        config.api_key = Some(secret.into());
        config.default_model = Some("test-model".into());
        OpenAiCompatibleProvider::new(config).unwrap()
    }

    fn assert_secret_redacted(error: &CodyError, secret: &str) {
        let error = error.to_string();
        assert!(error.contains("[REDACTED]"), "{error}");
        assert!(!error.contains(secret), "{error}");
    }

    #[test]
    fn appends_chat_completions_to_base_url() {
        assert_eq!(
            completion_endpoint("http://localhost:8080/v1/")
                .unwrap()
                .as_str(),
            "http://localhost:8080/v1/chat/completions"
        );
        assert_eq!(
            completion_endpoint("http://localhost:8080/chat/completions")
                .unwrap()
                .as_str(),
            "http://localhost:8080/chat/completions"
        );
    }

    #[test]
    fn maps_tool_call_and_usage() {
        let response: OpenAiResponse = serde_json::from_value(json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"README.md\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15
            }
        }))
        .unwrap();

        let response = decode_response(response).unwrap();
        assert_eq!(response.finish_reason, FinishReason::ToolCalls);
        assert_eq!(response.usage.unwrap().total_tokens, 15);
        assert!(matches!(
            &response.content[0],
            ModelContent::ToolCall { name, arguments, .. }
                if name == "read_file" && arguments["path"] == "README.md"
        ));
    }

    #[test]
    fn serializes_tool_results_as_separate_messages() {
        let messages = encode_messages(&[ModelMessage {
            role: ModelRole::Tool,
            content: vec![
                ModelContent::ToolResult {
                    tool_call_id: "one".into(),
                    name: "first".into(),
                    content: "a".into(),
                    is_error: false,
                    metadata: Value::Null,
                },
                ModelContent::ToolResult {
                    tool_call_id: "two".into(),
                    name: "second".into(),
                    content: "b".into(),
                    is_error: false,
                    metadata: Value::Null,
                },
            ],
        }])
        .unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("one"));
        assert_eq!(messages[1].tool_call_id.as_deref(), Some("two"));
    }

    #[tokio::test]
    async fn redacts_api_key_echoed_by_an_http_error() {
        let secret = "sk-compatible-http-canary";
        let body = json!({
            "error": {
                "message": format!("credential {secret} was rejected")
            }
        })
        .to_string();
        let (base_url, server) = spawn_mock_response(401, "Unauthorized", body).await;
        let provider = provider_for_test(base_url, secret);

        let error = provider
            .complete(ModelRequest::new("test-model", Vec::new()), None)
            .await
            .unwrap_err();

        assert_secret_redacted(&error, secret);
        assert!(!format!("{provider:?}").contains(secret));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn redacts_api_key_echoed_by_a_malformed_success_body() {
        let secret = "sk-compatible-decode-canary";
        let body = format!("{{\"choices\":[{{\"credential\":\"{secret}\"");
        let (base_url, server) = spawn_mock_response(200, "OK", body).await;
        let provider = provider_for_test(base_url, secret);

        let error = provider
            .complete(ModelRequest::new("test-model", Vec::new()), None)
            .await
            .unwrap_err();

        assert_secret_redacted(&error, secret);
        server.await.unwrap();
    }

    #[test]
    fn redacts_api_key_from_provider_errors_used_by_transport_paths() {
        let secret = "sk-compatible-transport-canary";
        let provider = provider_for_test("http://127.0.0.1:1/v1".into(), secret);
        let error = provider.provider_error(format!("transport failed for bearer {secret}"));

        assert_secret_redacted(&error, secret);
    }
}
