use std::{collections::HashSet, fmt, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{header, Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::{KodyError, Result};

use super::{
    AuthState, FinishReason, ModelContent, ModelDelta, ModelDeltaSink, ModelDescriptor,
    ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelRole, ModelUsage,
    ProviderCapabilities, ProviderDescriptor, ProviderErrorKind, ProviderFailure, ProviderHealth,
    ToolDefinition,
};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 256 * 1024;
const MAX_ACCUMULATED_ITEM_BYTES: usize = 8 * 1024 * 1024;

/// Configuration for OpenAI's streaming Responses API.
#[derive(Clone)]
pub struct OpenAiResponsesConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub require_api_key: bool,
    pub default_model: Option<String>,
    /// Offline/catalog fallback model IDs. They are used only if `/models`
    /// cannot be reached or returns no usable models.
    pub configured_models: Vec<String>,
    pub organization: Option<String>,
    pub project: Option<String>,
    pub timeout: Duration,
}

impl Default for OpenAiResponsesConfig {
    fn default() -> Self {
        Self {
            id: "openai-responses".into(),
            display_name: "OpenAI".into(),
            base_url: DEFAULT_BASE_URL.into(),
            api_key: None,
            require_api_key: true,
            default_model: None,
            configured_models: Vec::new(),
            organization: None,
            project: None,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

impl OpenAiResponsesConfig {
    pub fn new(id: impl Into<String>, base_url: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            base_url: base_url.into(),
            ..Self::default()
        }
    }
}

impl fmt::Debug for OpenAiResponsesConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesConfig")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("require_api_key", &self.require_api_key)
            .field("default_model", &self.default_model)
            .field("configured_models", &self.configured_models)
            .field("organization", &self.organization)
            .field("project", &self.project)
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Clone)]
pub struct OpenAiResponsesProvider {
    config: OpenAiResponsesConfig,
    client: Client,
    responses_endpoint: Url,
    models_endpoint: Url,
}

impl fmt::Debug for OpenAiResponsesProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiResponsesProvider")
            .field("config", &self.config)
            .field("responses_endpoint", &self.responses_endpoint)
            .field("models_endpoint", &self.models_endpoint)
            .finish_non_exhaustive()
    }
}

impl OpenAiResponsesProvider {
    pub fn new(config: OpenAiResponsesConfig) -> Result<Self> {
        validate_config(&config)?;
        let (responses_endpoint, models_endpoint) = endpoints(&config.base_url)?;
        let client = Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| {
                KodyError::Provider(format!("failed to build Responses client: {error}"))
            })?;
        Ok(Self {
            config,
            client,
            responses_endpoint,
            models_endpoint,
        })
    }

    pub fn config(&self) -> &OpenAiResponsesConfig {
        &self.config
    }

    pub fn responses_endpoint(&self) -> &Url {
        &self.responses_endpoint
    }

    pub fn models_endpoint(&self) -> &Url {
        &self.models_endpoint
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
                KodyError::InvalidInput(
                    "model must be specified in the request or Responses provider configuration"
                        .into(),
                )
            })
    }

    fn request(&self, method: Method, endpoint: Url) -> Result<RequestBuilder> {
        if self.config.require_api_key && self.config.api_key.is_none() {
            return Err(provider_failure(ProviderFailure::new(
                ProviderErrorKind::Authentication,
                "the Responses provider requires an API key",
            )));
        }
        let mut builder = self.client.request(method, endpoint);
        if let Some(api_key) = self.config.api_key.as_deref() {
            builder = builder.bearer_auth(api_key);
        }
        if let Some(organization) = self.config.organization.as_deref() {
            builder = builder.header("OpenAI-Organization", organization);
        }
        if let Some(project) = self.config.project.as_deref() {
            builder = builder.header("OpenAI-Project", project);
        }
        Ok(builder)
    }

    async fn fetch_models(&self) -> Result<Vec<ModelDescriptor>> {
        let response = self
            .request(Method::GET, self.models_endpoint.clone())?
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| self.transport_error("model catalog request", error))?;
        let status = response.status();
        let retry_after = response.headers().get(header::RETRY_AFTER).cloned();
        let body = read_bounded(response, MAX_ERROR_BYTES).await?;
        if !status.is_success() {
            return Err(provider_failure(self.http_error(
                status,
                retry_after.as_ref(),
                &body,
            )));
        }
        let catalog: ModelsResponse = serde_json::from_slice(&body).map_err(|error| {
            provider_failure(ProviderFailure::new(
                ProviderErrorKind::Protocol,
                format!("invalid /models response: {error}"),
            ))
        })?;
        let mut models = catalog
            .data
            .into_iter()
            .filter(|model| !model.id.trim().is_empty())
            .map(|model| ModelDescriptor {
                display_name: model.id.clone(),
                is_default: self.config.default_model.as_deref() == Some(model.id.as_str()),
                id: model.id,
                description: None,
                default_reasoning_effort: None,
                reasoning_efforts: Vec::new(),
                owned_by: model.owned_by,
                created_at: model.created,
            })
            .collect::<Vec<_>>();
        models.sort_by(|left, right| left.id.cmp(&right.id));
        models.dedup_by(|left, right| left.id == right.id);
        if models.is_empty() {
            return Err(provider_failure(ProviderFailure::new(
                ProviderErrorKind::Protocol,
                "the /models response contained no usable model IDs",
            )));
        }
        Ok(models)
    }

    fn configured_models(&self) -> Vec<ModelDescriptor> {
        let mut ids = self.config.configured_models.clone();
        if let Some(default) = self.config.default_model.as_ref() {
            ids.push(default.clone());
        }
        ids.retain(|id| !id.trim().is_empty());
        ids.sort();
        ids.dedup();
        ids.into_iter()
            .map(|id| {
                let is_default = self.config.default_model.as_deref() == Some(id.as_str());
                ModelDescriptor::new(id).with_default(is_default)
            })
            .collect()
    }

    fn transport_error(&self, operation: &str, error: reqwest::Error) -> KodyError {
        let kind = if error.is_timeout() {
            ProviderErrorKind::Timeout
        } else {
            ProviderErrorKind::Transport
        };
        provider_failure(ProviderFailure::new(
            kind,
            self.redact(&format!("{operation} failed: {error}")),
        ))
    }

    fn http_error(
        &self,
        status: StatusCode,
        retry_after: Option<&header::HeaderValue>,
        body: &[u8],
    ) -> ProviderFailure {
        let kind = match status.as_u16() {
            401 | 403 => ProviderErrorKind::Authentication,
            408 => ProviderErrorKind::Timeout,
            429 => ProviderErrorKind::RateLimited,
            400..=499 => ProviderErrorKind::InvalidRequest,
            500..=599 => ProviderErrorKind::Upstream,
            _ => ProviderErrorKind::Protocol,
        };
        let body = String::from_utf8_lossy(body);
        let message = self.redact(&format!(
            "Responses API returned {status}: {}",
            api_error_message(&body)
        ));
        let mut failure = ProviderFailure::new(kind, message);
        failure.retry_after_seconds = retry_after
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        failure
    }

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

    fn redact_error(&self, error: KodyError) -> KodyError {
        match error {
            KodyError::Provider(message) => KodyError::Provider(self.redact(&message)),
            other => other,
        }
    }
}

#[async_trait]
impl ModelProvider for OpenAiResponsesProvider {
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
            kind: "openai_responses".into(),
            auth: if !self.config.require_api_key {
                AuthState::NotRequired
            } else if self.config.api_key.is_some() {
                AuthState::Configured
            } else {
                AuthState::Missing
            },
            capabilities: ProviderCapabilities {
                streaming: true,
                reasoning: true,
                tools: true,
                model_catalog: true,
                custom_models: true,
            },
            default_model: self.config.default_model.clone(),
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelDescriptor>> {
        match self.fetch_models().await {
            Ok(models) => Ok(models),
            Err(error) => {
                let fallback = self.configured_models();
                if fallback.is_empty() {
                    Err(error)
                } else {
                    Ok(fallback)
                }
            }
        }
    }

    async fn health(&self) -> Result<ProviderHealth> {
        match self.fetch_models().await {
            Ok(_) => Ok(ProviderHealth::healthy()),
            Err(error) => Ok(ProviderHealth::unavailable(self.redact(&error.to_string()))),
        }
    }

    async fn complete(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse> {
        let model = self.resolve_model(&request)?.to_owned();
        let body = encode_request(&request, model)?;
        let response = self
            .request(Method::POST, self.responses_endpoint.clone())?
            .header(header::ACCEPT, "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|error| self.transport_error("Responses request", error))?;
        let status = response.status();
        let retry_after = response.headers().get(header::RETRY_AFTER).cloned();
        if !status.is_success() {
            let body = read_bounded(response, MAX_ERROR_BYTES).await?;
            return Err(provider_failure(self.http_error(
                status,
                retry_after.as_ref(),
                &body,
            )));
        }

        let mut decoder = SseDecoder::default();
        let mut state = ResponseStreamState::default();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| self.transport_error("Responses stream", error))?;
            for frame in decoder.push(&chunk)? {
                state
                    .apply(frame, delta_sink)
                    .await
                    .map_err(|error| self.redact_error(error))?;
            }
        }
        for frame in decoder.finish()? {
            state
                .apply(frame, delta_sink)
                .await
                .map_err(|error| self.redact_error(error))?;
        }
        state
            .finish(delta_sink)
            .await
            .map_err(|error| self.redact_error(error))
    }
}

fn validate_config(config: &OpenAiResponsesConfig) -> Result<()> {
    if config.id.trim().is_empty() || config.id != config.id.trim() {
        return Err(KodyError::InvalidInput(
            "Responses provider id must be non-empty without surrounding whitespace".into(),
        ));
    }
    if config.display_name.trim().is_empty() {
        return Err(KodyError::InvalidInput(
            "Responses provider display name must not be empty".into(),
        ));
    }
    if config.timeout.is_zero() {
        return Err(KodyError::InvalidInput(
            "Responses provider timeout must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn endpoints(base_url: &str) -> Result<(Url, Url)> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(KodyError::InvalidInput(
            "Responses provider base URL must not be empty".into(),
        ));
    }
    let root = trimmed.strip_suffix("/responses").unwrap_or(trimmed);
    let parsed = Url::parse(root).map_err(|error| {
        KodyError::InvalidInput(format!("invalid Responses base URL '{base_url}': {error}"))
    })?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(KodyError::InvalidInput(
            "Responses base URL must not contain credentials, a query, or a fragment".into(),
        ));
    }
    let root = parsed.as_str().trim_end_matches('/');
    let responses = Url::parse(&format!("{root}/responses"))
        .map_err(|error| KodyError::InvalidInput(error.to_string()))?;
    let models = Url::parse(&format!("{root}/models"))
        .map_err(|error| KodyError::InvalidInput(error.to_string()))?;
    Ok((responses, models))
}

fn encode_request(request: &ModelRequest, model: String) -> Result<Value> {
    let mut input = Vec::new();
    for message in &request.messages {
        encode_input_message(message, &mut input)?;
    }
    let mut body = Map::new();
    body.insert("model".into(), Value::String(model));
    body.insert("input".into(), Value::Array(input));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("store".into(), Value::Bool(false));
    if !request.tools.is_empty() {
        body.insert("tools".into(), Value::Array(encode_tools(&request.tools)));
    }
    if let Some(temperature) = request.temperature {
        let value = serde_json::Number::from_f64(temperature as f64)
            .ok_or_else(|| KodyError::InvalidInput("temperature must be a finite number".into()))?;
        body.insert("temperature".into(), Value::Number(value));
    }
    if let Some(maximum) = request.max_output_tokens {
        body.insert("max_output_tokens".into(), Value::from(maximum));
    }
    Ok(Value::Object(body))
}

fn encode_input_message(message: &ModelMessage, input: &mut Vec<Value>) -> Result<()> {
    match message.role {
        ModelRole::System | ModelRole::User => {
            let role = if message.role == ModelRole::System {
                "system"
            } else {
                "user"
            };
            let text = text_only(message, role)?;
            input.push(json!({
                "role": role,
                "content": [{ "type": "input_text", "text": text }]
            }));
        }
        ModelRole::Assistant => {
            let mut text = Vec::new();
            for content in &message.content {
                match content {
                    ModelContent::Text { text: part } => text.push(part.as_str()),
                    ModelContent::ToolCall {
                        id,
                        name,
                        arguments,
                    } => input.push(json!({
                        "type": "function_call",
                        "call_id": id,
                        "name": name,
                        "arguments": serde_json::to_string(arguments)?,
                    })),
                    ModelContent::ToolResult { .. } => {
                        return Err(KodyError::InvalidInput(
                            "assistant messages cannot contain tool results".into(),
                        ));
                    }
                }
            }
            if !text.is_empty() {
                input.push(json!({
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": text.join("\n") }]
                }));
            }
        }
        ModelRole::Tool => {
            if message.content.is_empty() {
                return Err(KodyError::InvalidInput(
                    "tool messages must contain at least one tool result".into(),
                ));
            }
            for content in &message.content {
                match content {
                    ModelContent::ToolResult {
                        tool_call_id,
                        content,
                        ..
                    } => input.push(json!({
                        "type": "function_call_output",
                        "call_id": tool_call_id,
                        "output": content,
                    })),
                    _ => {
                        return Err(KodyError::InvalidInput(
                            "tool messages may only contain tool results".into(),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn text_only(message: &ModelMessage, role: &str) -> Result<String> {
    let mut parts = Vec::new();
    for content in &message.content {
        match content {
            ModelContent::Text { text } => parts.push(text.as_str()),
            _ => {
                return Err(KodyError::InvalidInput(format!(
                    "{role} messages may only contain text"
                )));
            }
        }
    }
    Ok(parts.join("\n"))
}

fn encode_tools(tools: &[ToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<WireModel>,
}

#[derive(Debug, Deserialize)]
struct WireModel {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
    #[serde(default)]
    created: Option<i64>,
}

#[derive(Default)]
struct SseDecoder {
    pending: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
    received: usize,
}

struct SseFrame {
    event: Option<String>,
    data: String,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>> {
        self.received = self.received.saturating_add(chunk.len());
        if self.received > MAX_STREAM_BYTES {
            return Err(protocol_error(format!(
                "Responses stream exceeds {MAX_STREAM_BYTES} bytes"
            )));
        }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.consume_line(&line, &mut frames)?;
        }
        Ok(frames)
    }

    fn finish(mut self) -> Result<Vec<SseFrame>> {
        let mut frames = Vec::new();
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.consume_line(&line, &mut frames)?;
        }
        self.dispatch(&mut frames);
        Ok(frames)
    }

    fn consume_line(&mut self, line: &[u8], frames: &mut Vec<SseFrame>) -> Result<()> {
        if line.is_empty() {
            self.dispatch(frames);
            return Ok(());
        }
        if line[0] == b':' {
            return Ok(());
        }
        let line = std::str::from_utf8(line).map_err(|error| {
            protocol_error(format!("Responses SSE contained invalid UTF-8: {error}"))
        })?;
        if let Some(value) = line.strip_prefix("event:") {
            self.event = Some(value.trim_start().to_owned());
        } else if let Some(value) = line.strip_prefix("data:") {
            self.data.push(value.trim_start().to_owned());
        }
        Ok(())
    }

    fn dispatch(&mut self, frames: &mut Vec<SseFrame>) {
        if !self.data.is_empty() {
            frames.push(SseFrame {
                event: self.event.take(),
                data: std::mem::take(&mut self.data).join("\n"),
            });
        } else {
            self.event = None;
        }
    }
}

#[derive(Default)]
struct ResponseStreamState {
    streamed_text: String,
    functions: Vec<FunctionAccumulator>,
    completed_content: Option<Vec<ModelContent>>,
    usage: Option<ModelUsage>,
    finish_reason: Option<FinishReason>,
    emitted_tool_calls: HashSet<String>,
    saw_text_delta: bool,
    completed: bool,
}

#[derive(Default)]
struct FunctionAccumulator {
    item_id: Option<String>,
    output_index: Option<u64>,
    call_id: String,
    name: String,
    arguments: String,
}

impl ResponseStreamState {
    async fn apply(&mut self, frame: SseFrame, sink: Option<&dyn ModelDeltaSink>) -> Result<()> {
        if frame.data == "[DONE]" {
            return Ok(());
        }
        let value: Value = serde_json::from_str(&frame.data).map_err(|error| {
            protocol_error(format!("invalid Responses SSE event JSON: {error}"))
        })?;
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| frame.event.as_deref().filter(|event| !event.is_empty()))
            .unwrap_or_default();
        match event_type {
            "response.output_text.delta" => {
                let delta = required_string(&value, "delta", event_type)?;
                append_bounded(&mut self.streamed_text, delta, "output text")?;
                self.saw_text_delta = true;
                if let Some(sink) = sink {
                    sink.emit(ModelDelta::Text {
                        text: delta.to_owned(),
                    })
                    .await?;
                }
            }
            "response.reasoning_text.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning.delta" => {
                let delta = required_string(&value, "delta", event_type)?;
                if let Some(sink) = sink {
                    sink.emit(ModelDelta::Reasoning {
                        text: delta.to_owned(),
                    })
                    .await?;
                }
            }
            "response.output_item.added" => {
                if let Some(item) = value.get("item").filter(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call")
                }) {
                    self.upsert_function(item, value.get("output_index").and_then(Value::as_u64))?;
                }
            }
            "response.function_call_arguments.delta" => {
                let delta = required_string(&value, "delta", event_type)?;
                let function = self.function_for_event(&value);
                append_bounded(&mut function.arguments, delta, "function arguments")?;
            }
            "response.function_call_arguments.done" => {
                let arguments = value.get("arguments").and_then(Value::as_str);
                let call_id = {
                    let function = self.function_for_event(&value);
                    if let Some(arguments) = arguments {
                        function.arguments = arguments.to_owned();
                    }
                    function.call_id.clone()
                };
                self.emit_function(call_id, sink).await?;
            }
            "response.completed" => {
                let response = value.get("response").unwrap_or(&value);
                self.completed_content = Some(decode_completed_content(response)?);
                self.usage = decode_usage(response.get("usage"));
                self.finish_reason = Some(decode_response_finish(response));
                self.completed = true;
            }
            "response.incomplete" => {
                let response = value.get("response").unwrap_or(&value);
                self.completed_content = Some(decode_completed_content(response)?);
                self.usage = decode_usage(response.get("usage"));
                self.finish_reason = Some(decode_response_finish(response));
                self.completed = true;
            }
            "response.failed" | "error" => {
                let message = value
                    .pointer("/response/error/message")
                    .or_else(|| value.pointer("/error/message"))
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Responses stream reported a failure");
                return Err(provider_failure(ProviderFailure::new(
                    ProviderErrorKind::Upstream,
                    truncate(message, 2_000),
                )));
            }
            _ => {}
        }
        Ok(())
    }

    fn upsert_function(&mut self, item: &Value, output_index: Option<u64>) -> Result<()> {
        let item_id = item.get("id").and_then(Value::as_str).map(str::to_owned);
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .or_else(|| item.get("id").and_then(Value::as_str))
            .ok_or_else(|| protocol_error("function_call item is missing call_id"))?;
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("function_call item is missing name"))?;
        let arguments = item
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let function = self.function_by_key(item_id.as_deref(), output_index);
        function.item_id = item_id;
        function.output_index = output_index;
        function.call_id = call_id.to_owned();
        function.name = name.to_owned();
        function.arguments = arguments.to_owned();
        Ok(())
    }

    fn function_for_event(&mut self, value: &Value) -> &mut FunctionAccumulator {
        let item_id = value.get("item_id").and_then(Value::as_str);
        let output_index = value.get("output_index").and_then(Value::as_u64);
        self.function_by_key(item_id, output_index)
    }

    fn function_by_key(
        &mut self,
        item_id: Option<&str>,
        output_index: Option<u64>,
    ) -> &mut FunctionAccumulator {
        if let Some(index) = self.functions.iter().position(|function| {
            item_id.is_some_and(|id| function.item_id.as_deref() == Some(id))
                || output_index.is_some_and(|index| function.output_index == Some(index))
        }) {
            return &mut self.functions[index];
        }
        self.functions.push(FunctionAccumulator {
            item_id: item_id.map(str::to_owned),
            output_index,
            ..FunctionAccumulator::default()
        });
        self.functions.last_mut().expect("function was just pushed")
    }

    async fn emit_function(
        &mut self,
        call_id: String,
        sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<()> {
        if call_id.is_empty() || !self.emitted_tool_calls.insert(call_id.clone()) {
            return Ok(());
        }
        let function = self
            .functions
            .iter()
            .find(|function| function.call_id == call_id)
            .ok_or_else(|| protocol_error("function call disappeared during streaming"))?;
        let arguments = decode_arguments(&function.arguments, &call_id)?;
        if function.name.is_empty() {
            return Err(protocol_error(format!(
                "function call '{call_id}' is missing a name"
            )));
        }
        if let Some(sink) = sink {
            sink.emit(ModelDelta::ToolCall {
                id: call_id,
                name: function.name.clone(),
                arguments,
            })
            .await?;
        }
        Ok(())
    }

    async fn finish(mut self, sink: Option<&dyn ModelDeltaSink>) -> Result<ModelResponse> {
        if !self.completed {
            return Err(protocol_error(
                "Responses SSE stream ended without a completed or incomplete event",
            ));
        }
        let content = match self.completed_content.take() {
            Some(content) if !content.is_empty() => content,
            _ => self.accumulated_content()?,
        };
        if !self.saw_text_delta {
            for part in &content {
                if let (Some(sink), ModelContent::Text { text }) = (sink, part) {
                    sink.emit(ModelDelta::Text { text: text.clone() }).await?;
                }
            }
        }
        for part in &content {
            if let ModelContent::ToolCall {
                id,
                name,
                arguments,
            } = part
            {
                if self.emitted_tool_calls.insert(id.clone()) {
                    if let Some(sink) = sink {
                        sink.emit(ModelDelta::ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone(),
                        })
                        .await?;
                    }
                }
            }
        }
        let finish_reason = self.finish_reason.unwrap_or_else(|| {
            if content
                .iter()
                .any(|part| matches!(part, ModelContent::ToolCall { .. }))
            {
                FinishReason::ToolCalls
            } else {
                FinishReason::Stop
            }
        });
        if let Some(sink) = sink {
            sink.emit(ModelDelta::Done {
                finish_reason: finish_reason.clone(),
                usage: self.usage,
            })
            .await?;
        }
        Ok(ModelResponse {
            content,
            finish_reason,
            usage: self.usage,
        })
    }

    fn accumulated_content(&self) -> Result<Vec<ModelContent>> {
        let mut content = Vec::new();
        if !self.streamed_text.is_empty() {
            content.push(ModelContent::Text {
                text: self.streamed_text.clone(),
            });
        }
        for function in &self.functions {
            if function.call_id.is_empty() || function.name.is_empty() {
                continue;
            }
            content.push(ModelContent::ToolCall {
                id: function.call_id.clone(),
                name: function.name.clone(),
                arguments: decode_arguments(&function.arguments, &function.call_id)?,
            });
        }
        Ok(content)
    }
}

fn decode_completed_content(response: &Value) -> Result<Vec<ModelContent>> {
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for part in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(value) = part.get("text").and_then(Value::as_str) {
                            append_bounded(&mut text, value, "completed output text")?;
                        }
                    }
                }
            }
            Some("function_call") => {
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("id").and_then(Value::as_str))
                    .ok_or_else(|| protocol_error("completed function call is missing call_id"))?;
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("completed function call is missing name"))?;
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                calls.push(ModelContent::ToolCall {
                    id: call_id.to_owned(),
                    name: name.to_owned(),
                    arguments: decode_arguments(arguments, call_id)?,
                });
            }
            _ => {}
        }
    }
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(ModelContent::Text { text });
    }
    content.extend(calls);
    Ok(content)
}

fn decode_response_finish(response: &Value) -> FinishReason {
    if response.get("status").and_then(Value::as_str) == Some("incomplete") {
        return match response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
        {
            Some("max_output_tokens") => FinishReason::Length,
            Some("content_filter") => FinishReason::ContentFilter,
            Some(reason) => FinishReason::Other(reason.to_owned()),
            None => FinishReason::Other("incomplete".into()),
        };
    }
    let has_calls = response
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|output| {
            output
                .iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        });
    if has_calls {
        FinishReason::ToolCalls
    } else {
        FinishReason::Stop
    }
}

fn decode_usage(usage: Option<&Value>) -> Option<ModelUsage> {
    let usage = usage?;
    let input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));
    Some(ModelUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

fn decode_arguments(arguments: &str, call_id: &str) -> Result<Value> {
    if arguments.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(arguments).map_err(|error| {
        protocol_error(format!(
            "function call '{call_id}' returned invalid JSON arguments: {error}"
        ))
    })
}

fn append_bounded(target: &mut String, value: &str, label: &str) -> Result<()> {
    if target.len().saturating_add(value.len()) > MAX_ACCUMULATED_ITEM_BYTES {
        return Err(protocol_error(format!(
            "Responses {label} exceeds {MAX_ACCUMULATED_ITEM_BYTES} bytes"
        )));
    }
    target.push_str(value);
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str, event: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error(format!("Responses event '{event}' is missing '{key}'")))
}

async fn read_bounded(mut response: Response, maximum: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(protocol_error(format!(
            "provider response exceeds {maximum} bytes"
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        provider_failure(ProviderFailure::new(
            ProviderErrorKind::Transport,
            format!("failed to read provider response: {error}"),
        ))
    })? {
        if body.len().saturating_add(chunk.len()) > maximum {
            return Err(protocol_error(format!(
                "provider response exceeds {maximum} bytes"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn protocol_error(message: impl Into<String>) -> KodyError {
    provider_failure(ProviderFailure::new(ProviderErrorKind::Protocol, message))
}

fn provider_failure(failure: ProviderFailure) -> KodyError {
    KodyError::Provider(failure.to_string())
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

fn truncate(value: &str, maximum: usize) -> String {
    let mut characters = value.chars();
    let prefix = characters.by_ref().take(maximum).collect::<String>();
    if characters.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::{oneshot, Mutex},
        time::sleep,
    };
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        deltas: Mutex<Vec<ModelDelta>>,
    }

    #[async_trait]
    impl ModelDeltaSink for RecordingSink {
        async fn emit(&self, delta: ModelDelta) -> Result<()> {
            self.deltas.lock().await.push(delta);
            Ok(())
        }
    }

    struct MockHttpResponse {
        status: u16,
        headers: Vec<(String, String)>,
        chunks: Vec<Vec<u8>>,
        delay_before_body: Duration,
    }

    impl MockHttpResponse {
        fn sse(chunks: impl IntoIterator<Item = impl Into<Vec<u8>>>) -> Self {
            Self {
                status: 200,
                headers: vec![("Content-Type".into(), "text/event-stream".into())],
                chunks: chunks.into_iter().map(Into::into).collect(),
                delay_before_body: Duration::ZERO,
            }
        }

        fn json(status: u16, body: Value) -> Self {
            Self {
                status,
                headers: vec![("Content-Type".into(), "application/json".into())],
                chunks: vec![serde_json::to_vec(&body).unwrap()],
                delay_before_body: Duration::ZERO,
            }
        }
    }

    async fn spawn_mock(
        response: MockHttpResponse,
    ) -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let _ = request_tx.send(String::from_utf8_lossy(&request).into_owned());
            let reason = match response.status {
                200 => "OK",
                401 => "Unauthorized",
                429 => "Too Many Requests",
                _ => "Error",
            };
            let mut head = format!(
                "HTTP/1.1 {} {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n",
                response.status, reason
            );
            for (name, value) in response.headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str("\r\n");
            socket.write_all(head.as_bytes()).await.unwrap();
            if !response.delay_before_body.is_zero() {
                sleep(response.delay_before_body).await;
            }
            for chunk in response.chunks {
                if socket
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await
                    .is_err()
                {
                    return;
                }
                if socket.write_all(&chunk).await.is_err()
                    || socket.write_all(b"\r\n").await.is_err()
                {
                    return;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        (format!("http://{address}/v1"), request_rx, task)
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4_096];
        let mut expected = None;
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if expected.is_none() {
                if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or_default();
                    expected = Some(header_end + 4 + length);
                }
            }
            if expected.is_some_and(|length| request.len() >= length) {
                break;
            }
        }
        request
    }

    fn provider(base_url: String, secret: &str) -> OpenAiResponsesProvider {
        let mut config = OpenAiResponsesConfig::new("responses", base_url);
        config.display_name = "Responses Test".into();
        config.api_key = Some(secret.into());
        config.default_model = Some("gpt-test".into());
        OpenAiResponsesProvider::new(config).unwrap()
    }

    #[tokio::test]
    async fn parses_fragmented_text_reasoning_function_call_and_usage() {
        let events = [
            "event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"plan\"}\n\n",
            "event: response.output_text.delta\ndata: {\"delta\":\"Hel\"}\n\n",
            "event: response.output_text.delta\ndata: {\"delta\":\"lo\"}\n\n",
            "event: response.output_item.added\ndata: {\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"fc_1\",\"output_index\":1,\"delta\":\"{\\\"path\\\":\"}\n\n",
            "event: response.function_call_arguments.done\ndata: {\"item_id\":\"fc_1\",\"output_index\":1,\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}\n\n",
            "event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\"}]},{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n",
            "data: [DONE]\n\n",
        ]
        .concat();
        // Deliberately split through UTF-8/SSE/JSON boundaries rather than on
        // event boundaries.
        let chunks = events
            .as_bytes()
            .chunks(17)
            .map(Vec::from)
            .collect::<Vec<_>>();
        let (base_url, request_rx, server) = spawn_mock(MockHttpResponse::sse(chunks)).await;
        let provider = provider(base_url, "sk-fragment-secret");
        let sink = RecordingSink::default();
        let request = ModelRequest::new(
            "gpt-test",
            vec![ModelMessage::text(ModelRole::User, "inspect")],
        )
        .with_tools(vec![ToolDefinition::new(
            "read_file",
            "Read a file",
            json!({"type":"object","properties":{"path":{"type":"string"}}}),
        )]);

        let response = provider.complete(request, Some(&sink)).await.unwrap();
        assert_eq!(response.text_content(), "Hello");
        assert_eq!(response.finish_reason, FinishReason::ToolCalls);
        assert_eq!(response.usage.unwrap().total_tokens, 15);
        let tool = response.tool_calls().next().unwrap();
        assert_eq!(tool.name, "read_file");
        assert_eq!(tool.arguments["path"], "README.md");
        let deltas = sink.deltas.lock().await;
        assert!(deltas
            .iter()
            .any(|delta| matches!(delta, ModelDelta::Reasoning { text } if text == "plan")));
        assert_eq!(
            deltas
                .iter()
                .filter_map(|delta| match delta {
                    ModelDelta::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
            "Hello"
        );
        assert_eq!(
            deltas
                .iter()
                .filter(|delta| matches!(delta, ModelDelta::ToolCall { .. }))
                .count(),
            1
        );

        let wire_request = request_rx.await.unwrap();
        assert!(wire_request.starts_with("POST /v1/responses HTTP/1.1"));
        assert!(wire_request.contains("authorization: Bearer sk-fragment-secret"));
        assert!(wire_request.contains("\"stream\":true"));
        assert!(wire_request.contains("\"name\":\"read_file\""));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn classifies_401_and_redacts_secret_everywhere() {
        let secret = "sk-never-print-this";
        let (base_url, _request, server) = spawn_mock(MockHttpResponse::json(
            401,
            json!({"error":{"message":format!("bad credential {secret}")}}),
        ))
        .await;
        let provider = provider(base_url, secret);
        let error = provider
            .complete(ModelRequest::new("gpt-test", Vec::new()), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("authentication"));
        assert!(error.contains("[REDACTED]"));
        assert!(!error.contains(secret));
        assert!(!format!("{provider:?}").contains(secret));
        assert!(!serde_json::to_string(&provider.descriptor())
            .unwrap()
            .contains(secret));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn classifies_429_and_preserves_retry_after() {
        let mut response = MockHttpResponse::json(429, json!({"error":{"message":"slow down"}}));
        response.headers.push(("Retry-After".into(), "7".into()));
        let (base_url, _request, server) = spawn_mock(response).await;
        let provider = provider(base_url, "sk-rate-limit");
        let error = provider
            .complete(ModelRequest::new("gpt-test", Vec::new()), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("rate_limited"));
        assert!(error.contains("retry after 7s"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn lists_and_sorts_remote_models() {
        let (base_url, request_rx, server) = spawn_mock(MockHttpResponse::json(
            200,
            json!({"data":[
                {"id":"z-model","owned_by":"team","created":20},
                {"id":"a-model","owned_by":"openai","created":10},
                {"id":"a-model","owned_by":"duplicate","created":30}
            ]}),
        ))
        .await;
        let mut config = OpenAiResponsesConfig::new("responses", base_url);
        config.api_key = Some("sk-models".into());
        config.default_model = Some("a-model".into());
        let provider = OpenAiResponsesProvider::new(config).unwrap();
        let models = provider.list_models().await.unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["a-model", "z-model"]
        );
        assert_eq!(models[0].owned_by.as_deref(), Some("openai"));
        assert!(models[0].is_default);
        assert!(!models[1].is_default);
        assert!(request_rx
            .await
            .unwrap()
            .starts_with("GET /v1/models HTTP/1.1"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_drops_a_slow_stream() {
        let completed = "event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n";
        let mut response = MockHttpResponse::sse([completed]);
        response.delay_before_body = Duration::from_secs(5);
        let (base_url, request_rx, server) = spawn_mock(response).await;
        let provider = Arc::new(provider(base_url, "sk-cancel"));
        let cancellation = CancellationToken::new();
        let task = {
            let provider = provider.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                provider
                    .complete_cancellable(
                        ModelRequest::new("gpt-test", Vec::new()),
                        None,
                        cancellation,
                    )
                    .await
            })
        };
        let _ = request_rx.await.unwrap();
        cancellation.cancel();
        assert!(matches!(task.await.unwrap(), Err(KodyError::Cancelled)));
        server.abort();
    }

    #[test]
    fn descriptor_reports_auth_without_exposing_the_key() {
        let provider = provider("http://127.0.0.1:9/v1".into(), "sk-descriptor");
        let descriptor = provider.descriptor();
        assert_eq!(descriptor.auth, AuthState::Configured);
        assert!(descriptor.capabilities.streaming);
        assert!(descriptor.capabilities.reasoning);
        assert_eq!(descriptor.default_model.as_deref(), Some("gpt-test"));
        assert!(!format!("{descriptor:?}").contains("sk-descriptor"));
    }
}
