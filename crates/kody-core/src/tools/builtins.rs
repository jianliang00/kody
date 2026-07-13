use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    io,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    task::JoinHandle,
    time::{sleep, timeout},
};

use crate::{
    domain::{ProjectAccess, ProjectId},
    error::{KodyError, Result},
};

use super::{Tool, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolRisk};

const DEFAULT_FILE_BYTES: usize = 256 * 1024;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const DEFAULT_DIRECTORY_ENTRIES: usize = 1_000;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const DEFAULT_SHELL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_SHELL_OUTPUT_BYTES: usize = 1024 * 1024;
const DEFAULT_SHELL_TIMEOUT_MS: u64 = 120_000;
const MAX_SHELL_TIMEOUT_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, Default)]
pub struct ReadFileTool;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadFileArguments {
    path: String,
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    max_bytes: Option<usize>,
}

#[async_trait]
impl Tool for ReadFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "read_file",
            "Read a UTF-8 text file relative to the thread workspace or a referenced project.",
            json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Relative path below the selected root."
                    },
                    "project_id": {
                        "type": "string",
                        "format": "uuid",
                        "description": "Referenced project to read from; omit for the workspace."
                    },
                    "max_bytes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_FILE_BYTES,
                        "default": DEFAULT_FILE_BYTES
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: ReadFileArguments = parse_arguments(call)?;
        let limit = checked_limit(
            "max_bytes",
            arguments.max_bytes.unwrap_or(DEFAULT_FILE_BYTES),
            MAX_FILE_BYTES,
        )?;
        context.check_cancelled()?;

        let selected = select_root(context, arguments.project_id, false).await?;
        let relative = validate_relative_path(&arguments.path)?;
        let target = confined_existing_path(&selected.root, &relative).await?;
        let metadata = fs::metadata(&target).await?;
        if !metadata.is_file() {
            return Err(KodyError::InvalidInput(format!(
                "'{}' is not a file",
                arguments.path
            )));
        }

        let file = fs::File::open(&target).await?;
        let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
        let mut reader = file.take((limit + 1) as u64);
        tokio::select! {
            biased;
            _ = context.cancellation_token.cancelled() => return Err(KodyError::Cancelled),
            result = reader.read_to_end(&mut bytes) => { result?; }
        }

        let truncated = bytes.len() > limit;
        bytes.truncate(limit);
        let content = String::from_utf8_lossy(&bytes).into_owned();

        Ok(ToolResult::success(
            call,
            content,
            target_metadata(
                &relative,
                arguments.project_id,
                json!({
                    "bytes_read": bytes.len(),
                    "truncated": truncated,
                }),
            ),
        ))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct WriteFileTool;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteFileArguments {
    path: String,
    content: String,
    #[serde(default)]
    project_id: Option<ProjectId>,
}

#[async_trait]
impl Tool for WriteFileTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "write_file",
            "Write a UTF-8 file relative to the workspace or a read-write referenced project, creating parent directories as needed.",
            json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Relative path below the selected root."
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete replacement contents of the file."
                    },
                    "project_id": {
                        "type": "string",
                        "format": "uuid",
                        "description": "Referenced project to write to; omit for the workspace."
                    }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
        )
    }

    fn risk(&self) -> ToolRisk {
        ToolRisk::FilesystemWrite
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: WriteFileArguments = parse_arguments(call)?;
        context.check_cancelled()?;

        let selected = select_root(context, arguments.project_id, true).await?;
        let relative = validate_relative_path(&arguments.path)?;
        let target = confined_write_path(&selected.root, &relative).await?;
        let parent = target.parent().ok_or_else(|| {
            KodyError::InvalidInput(format!("invalid file path '{}'", arguments.path))
        })?;

        cancellable(&context.cancellation_token, fs::create_dir_all(parent)).await?;
        // Re-check after creating parents so a symlink swap cannot trivially
        // turn a valid missing path into an escape before the write.
        ensure_canonical_path_is_confined(&selected.root, parent).await?;
        cancellable(
            &context.cancellation_token,
            fs::write(&target, arguments.content.as_bytes()),
        )
        .await?;

        Ok(ToolResult::success(
            call,
            format!(
                "wrote {} bytes to {}",
                arguments.content.len(),
                arguments.path
            ),
            target_metadata(
                &relative,
                arguments.project_id,
                json!({ "bytes_written": arguments.content.len() }),
            ),
        ))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ListDirectoryTool;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListDirectoryArguments {
    #[serde(default = "default_directory_path")]
    path: String,
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    max_entries: Option<usize>,
}

fn default_directory_path() -> String {
    ".".to_owned()
}

#[async_trait]
impl Tool for ListDirectoryTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "list_directory",
            "List one directory relative to the thread workspace or a referenced project.",
            json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "default": ".",
                        "description": "Relative directory path below the selected root."
                    },
                    "project_id": {
                        "type": "string",
                        "format": "uuid",
                        "description": "Referenced project to list; omit for the workspace."
                    },
                    "max_entries": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_DIRECTORY_ENTRIES,
                        "default": DEFAULT_DIRECTORY_ENTRIES
                    }
                },
                "additionalProperties": false
            }),
        )
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: ListDirectoryArguments = parse_arguments(call)?;
        let limit = checked_limit(
            "max_entries",
            arguments.max_entries.unwrap_or(DEFAULT_DIRECTORY_ENTRIES),
            MAX_DIRECTORY_ENTRIES,
        )?;
        context.check_cancelled()?;

        let selected = select_root(context, arguments.project_id, false).await?;
        let relative = validate_relative_path(&arguments.path)?;
        let target = confined_existing_path(&selected.root, &relative).await?;
        let metadata = fs::metadata(&target).await?;
        if !metadata.is_dir() {
            return Err(KodyError::InvalidInput(format!(
                "'{}' is not a directory",
                arguments.path
            )));
        }

        let mut directory = fs::read_dir(&target).await?;
        let mut entries = Vec::new();
        let mut truncated = false;

        loop {
            let next = tokio::select! {
                biased;
                _ = context.cancellation_token.cancelled() => return Err(KodyError::Cancelled),
                result = directory.next_entry() => result?,
            };
            let Some(entry) = next else { break };

            if entries.len() == limit {
                truncated = true;
                break;
            }

            let file_type = entry.file_type().await?;
            let suffix = if file_type.is_dir() {
                "/"
            } else if file_type.is_symlink() {
                "@"
            } else {
                ""
            };
            entries.push(format!("{}{}", entry.file_name().to_string_lossy(), suffix));
        }

        entries.sort();
        let content = entries.join("\n");
        Ok(ToolResult::success(
            call,
            content,
            target_metadata(
                &relative,
                arguments.project_id,
                json!({
                    "entry_count": entries.len(),
                    "truncated": truncated,
                }),
            ),
        ))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ShellTool;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShellArguments {
    command: String,
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_output_bytes: Option<usize>,
}

#[async_trait]
impl Tool for ShellTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "shell",
            "Run a shell command with the selected workspace or read-write project as its working directory. Output is bounded.",
            json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Command passed to sh -lc."
                    },
                    "project_id": {
                        "type": "string",
                        "format": "uuid",
                        "description": "Referenced project to use as cwd; omit for the workspace."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_SHELL_TIMEOUT_MS,
                        "default": DEFAULT_SHELL_TIMEOUT_MS
                    },
                    "max_output_bytes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_SHELL_OUTPUT_BYTES,
                        "default": DEFAULT_SHELL_OUTPUT_BYTES,
                        "description": "Maximum bytes retained from each of stdout and stderr."
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        )
    }

    fn risk(&self) -> ToolRisk {
        ToolRisk::CommandExecution
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: ShellArguments = parse_arguments(call)?;
        if arguments.command.trim().is_empty() {
            return Err(KodyError::InvalidInput(
                "shell command cannot be empty".to_owned(),
            ));
        }
        let timeout_ms = arguments.timeout_ms.unwrap_or(DEFAULT_SHELL_TIMEOUT_MS);
        if timeout_ms == 0 || timeout_ms > MAX_SHELL_TIMEOUT_MS {
            return Err(KodyError::InvalidInput(format!(
                "timeout_ms must be between 1 and {MAX_SHELL_TIMEOUT_MS}"
            )));
        }
        let output_limit = checked_limit(
            "max_output_bytes",
            arguments
                .max_output_bytes
                .unwrap_or(DEFAULT_SHELL_OUTPUT_BYTES),
            MAX_SHELL_OUTPUT_BYTES,
        )?;
        context.check_cancelled()?;

        // Shell is considered mutating even when the supplied command appears
        // read-only: arbitrary shell syntax cannot be classified safely.
        let selected = select_root(context, arguments.project_id, true).await?;
        let mut command = Command::new("sh");
        command
            .arg("-lc")
            .arg(&arguments.command)
            .current_dir(&selected.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        configure_shell_environment(&mut command, &selected.root);
        // A separate process group lets timeout/cancellation terminate
        // grandchildren as well as the immediate `sh` process.
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command
            .spawn()
            .map_err(|error| KodyError::Tool(format!("failed to start shell command: {error}")))?;
        // Capture the process-group id before `wait`: Tokio no longer exposes
        // the child id after it has been reaped. A foreground shell call must
        // never become an alternate way to leave an unmanaged daemon behind.
        #[cfg(unix)]
        let process_group_id = child.id().and_then(|pid| i32::try_from(pid).ok());
        #[cfg(not(unix))]
        let process_group_id = None;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| KodyError::Tool("failed to capture shell standard output".to_owned()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| KodyError::Tool("failed to capture shell standard error".to_owned()))?;
        let stdout_task = tokio::spawn(read_bounded(stdout, output_limit));
        let stderr_task = tokio::spawn(read_bounded(stderr, output_limit));

        let deadline = sleep(Duration::from_millis(timeout_ms));
        tokio::pin!(deadline);

        let outcome = tokio::select! {
            biased;
            _ = context.cancellation_token.cancelled() => ShellOutcome::Cancelled,
            _ = &mut deadline => ShellOutcome::TimedOut,
            status = child.wait() => ShellOutcome::Exited(status?),
        };

        match outcome {
            ShellOutcome::Cancelled => {
                terminate_child(&mut child, process_group_id).await?;
                stdout_task.abort();
                stderr_task.abort();
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return Err(KodyError::Cancelled);
            }
            ShellOutcome::TimedOut => {
                terminate_child(&mut child, process_group_id).await?;
                let stdout = collect_reader(stdout_task).await?;
                let stderr = collect_reader(stderr_task).await?;
                return Ok(shell_result(
                    call,
                    arguments.project_id,
                    None,
                    stdout,
                    stderr,
                    true,
                ));
            }
            ShellOutcome::Exited(status) => {
                // The shell can exit after `command &` while descendants keep
                // running and retain its output pipes. Those descendants are
                // not managed processes, so terminate the remaining group
                // before collecting output. Long-lived work must use
                // `start_process`, where it receives durable supervision.
                terminate_process_group(process_group_id)?;
                let stdout = collect_reader(stdout_task).await?;
                let stderr = collect_reader(stderr_task).await?;
                Ok(shell_result(
                    call,
                    arguments.project_id,
                    status.code(),
                    stdout,
                    stderr,
                    false,
                ))
            }
        }
    }
}

enum ShellOutcome {
    Cancelled,
    TimedOut,
    Exited(std::process::ExitStatus),
}

pub(super) struct SelectedRoot {
    pub(super) root: PathBuf,
}

pub(super) async fn select_root(
    context: &ToolContext,
    project_id: Option<ProjectId>,
    requires_write: bool,
) -> Result<SelectedRoot> {
    let root = match project_id {
        None => context.workspace.root.clone(),
        Some(project_id) => {
            let binding = context.project(project_id).ok_or_else(|| {
                KodyError::InvalidInput(format!(
                    "project {project_id} is not referenced by this thread"
                ))
            })?;
            if requires_write && binding.access == ProjectAccess::ReadOnly {
                return Err(KodyError::Tool(format!(
                    "project {project_id} is read-only"
                )));
            }
            binding.project.root.clone()
        }
    };

    let root = fs::canonicalize(&root).await.map_err(|error| {
        KodyError::Tool(format!(
            "cannot access selected root '{}': {error}",
            root.display()
        ))
    })?;
    let metadata = fs::metadata(&root).await?;
    if !metadata.is_dir() {
        return Err(KodyError::Tool(format!(
            "selected root '{}' is not a directory",
            root.display()
        )));
    }

    Ok(SelectedRoot { root })
}

pub(super) fn validate_relative_path(input: &str) -> Result<PathBuf> {
    if input.is_empty() {
        return Err(KodyError::InvalidInput("path cannot be empty".to_owned()));
    }

    let path = Path::new(input);
    if path.is_absolute() {
        return Err(KodyError::InvalidInput(format!(
            "path '{input}' must be relative"
        )));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(KodyError::InvalidInput(format!(
                    "path '{input}' cannot contain '..'"
                )))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(KodyError::InvalidInput(format!(
                    "path '{input}' must be relative"
                )))
            }
        }
    }

    // `.` intentionally means the selected root (for list_directory).
    Ok(normalized)
}

pub(super) async fn confined_existing_path(root: &Path, relative: &Path) -> Result<PathBuf> {
    let candidate = root.join(relative);
    let canonical = fs::canonicalize(&candidate).await.map_err(|error| {
        KodyError::Tool(format!("cannot access '{}': {error}", relative.display()))
    })?;
    ensure_confined(root, &canonical, relative)?;
    Ok(canonical)
}

async fn confined_write_path(root: &Path, relative: &Path) -> Result<PathBuf> {
    if relative.as_os_str().is_empty() {
        return Err(KodyError::InvalidInput(
            "write_file path must name a file".to_owned(),
        ));
    }

    let candidate = root.join(relative);
    if fs::symlink_metadata(&candidate).await.is_ok() {
        let canonical = fs::canonicalize(&candidate).await.map_err(|error| {
            KodyError::Tool(format!("cannot access '{}': {error}", relative.display()))
        })?;
        ensure_confined(root, &canonical, relative)?;
        return Ok(canonical);
    }

    let mut ancestor = candidate.parent();
    while let Some(path) = ancestor {
        match fs::canonicalize(path).await {
            Ok(canonical) => {
                ensure_confined(root, &canonical, relative)?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ancestor = path.parent();
            }
            Err(error) => return Err(error.into()),
        }
    }

    Err(KodyError::InvalidInput(format!(
        "cannot resolve parent of '{}'",
        relative.display()
    )))
}

async fn ensure_canonical_path_is_confined(root: &Path, path: &Path) -> Result<()> {
    let canonical = fs::canonicalize(path).await?;
    ensure_confined(root, &canonical, path)
}

fn ensure_confined(root: &Path, canonical: &Path, display_path: &Path) -> Result<()> {
    if canonical.starts_with(root) {
        Ok(())
    } else {
        Err(KodyError::InvalidInput(format!(
            "path '{}' resolves outside the selected root",
            display_path.display()
        )))
    }
}

fn parse_arguments<T>(call: &ToolCall) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(call.arguments.clone()).map_err(|error| {
        KodyError::InvalidInput(format!("invalid arguments for '{}': {error}", call.name))
    })
}

fn checked_limit(name: &str, value: usize, maximum: usize) -> Result<usize> {
    if value == 0 || value > maximum {
        Err(KodyError::InvalidInput(format!(
            "{name} must be between 1 and {maximum}"
        )))
    } else {
        Ok(value)
    }
}

fn target_metadata(relative: &Path, project_id: Option<ProjectId>, extra: Value) -> Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "path".to_owned(),
        Value::String(if relative.as_os_str().is_empty() {
            ".".to_owned()
        } else {
            relative.to_string_lossy().into_owned()
        }),
    );
    if let Some(project_id) = project_id {
        metadata.insert(
            "project_id".to_owned(),
            Value::String(project_id.to_string()),
        );
    } else {
        metadata.insert("root".to_owned(), Value::String("workspace".to_owned()));
    }
    if let Value::Object(extra) = extra {
        metadata.extend(extra);
    }
    Value::Object(metadata)
}

async fn cancellable<T>(
    cancellation_token: &tokio_util::sync::CancellationToken,
    operation: impl std::future::Future<Output = io::Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => Err(KodyError::Cancelled),
        result = operation => Ok(result?),
    }
}

struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_bounded<R>(mut reader: R, limit: usize) -> io::Result<BoundedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(limit.min(16 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let available = limit.saturating_sub(retained.len());
        let retain = read.min(available);
        retained.extend_from_slice(&buffer[..retain]);
        truncated |= retain < read;
    }

    Ok(BoundedOutput {
        bytes: retained,
        truncated,
    })
}

async fn collect_reader(mut task: JoinHandle<io::Result<BoundedOutput>>) -> Result<BoundedOutput> {
    match timeout(Duration::from_secs(1), &mut task).await {
        Ok(joined) => joined
            .map_err(|error| KodyError::Tool(format!("output reader task failed: {error}")))?
            .map_err(KodyError::Io),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(KodyError::Tool(
                "shell output pipe did not close after command exited".to_owned(),
            ))
        }
    }
}

async fn terminate_child(
    child: &mut tokio::process::Child,
    process_group_id: Option<i32>,
) -> Result<()> {
    let group_result = terminate_process_group(process_group_id);
    let child_result = child.kill().await;
    let _ = child.wait().await;
    group_result?;
    if let Err(error) = child_result {
        // The process-group signal may have reaped the direct child first.
        if error.kind() != io::ErrorKind::InvalidInput {
            return Err(error.into());
        }
    }
    Ok(())
}

fn terminate_process_group(process_group_id: Option<i32>) -> Result<()> {
    #[cfg(unix)]
    if let Some(process_group_id) = process_group_id.filter(|id| *id > 0) {
        // SAFETY: a negative pid addresses the process group created above;
        // SIGKILL requires no pointers or shared-memory access.
        let result = unsafe { libc::kill(-process_group_id, libc::SIGKILL) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
    }

    #[cfg(not(unix))]
    let _ = process_group_id;

    Ok(())
}

/// Do not expose provider keys, auth tokens, or the server's general process
/// environment to model-authored shell commands. A small set of path and
/// terminal variables is retained so normal developer commands still work.
fn configure_shell_environment(command: &mut Command, root: &Path) {
    command.env_clear();
    visit_shell_environment(root, |name, value| {
        command.env(name, value);
    });
}

/// Build the same credential-free environment used by the blocking shell tool
/// for a command that will be owned by the process manager. Values are lossy
/// UTF-8 because durable process requests intentionally use portable strings.
pub(super) fn sanitized_process_environment(root: &Path) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::new();
    visit_shell_environment(root, |name, value| {
        environment.insert(name.to_owned(), value.to_string_lossy().into_owned());
    });
    environment
}

fn visit_shell_environment(root: &Path, mut visit: impl FnMut(&str, OsString)) {
    // Keep this single source of truth shared by foreground and managed
    // commands so neither execution mode accidentally gains ambient secrets.
    visit("HOME", root.as_os_str().to_owned());
    visit("PWD", root.as_os_str().to_owned());
    visit(
        "PATH",
        env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/local/bin:/usr/bin:/bin")),
    );

    for name in [
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "COLORTERM",
        "DEVELOPER_DIR",
        "SDKROOT",
        "RUSTUP_HOME",
    ] {
        if let Some(value) = env::var_os(name) {
            visit(name, value);
        }
    }

    // Never expose the user's Cargo credentials. Projects needing a private
    // registry can opt into a separately mediated credential mount later.
    visit("CARGO_HOME", root.join(".kody-home/cargo").into_os_string());
    // Rustup shims need the installed toolchains, which contain no registry
    // credentials. Keep that path when it is explicitly configured.
    if env::var_os("RUSTUP_HOME").is_none() {
        if let Some(home) = env::var_os("HOME") {
            visit(
                "RUSTUP_HOME",
                append_path(&home, ".rustup").into_os_string(),
            );
        }
    }
}

fn append_path(base: &OsString, component: &str) -> PathBuf {
    let mut path = PathBuf::from(base);
    path.push(component);
    path
}

fn shell_result(
    call: &ToolCall,
    project_id: Option<ProjectId>,
    exit_code: Option<i32>,
    stdout: BoundedOutput,
    stderr: BoundedOutput,
    timed_out: bool,
) -> ToolResult {
    let stdout_text = String::from_utf8_lossy(&stdout.bytes);
    let stderr_text = String::from_utf8_lossy(&stderr.bytes);
    let mut content = format!(
        "exit_code: {}\nstdout:\n{}\nstderr:\n{}",
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_owned()),
        stdout_text,
        stderr_text,
    );
    if stdout.truncated || stderr.truncated {
        content.push_str("\n[output truncated]");
    }
    if timed_out {
        content.push_str("\n[command timed out]");
    }

    let metadata = json!({
        "project_id": project_id.map(|id| id.to_string()),
        "exit_code": exit_code,
        "stdout_truncated": stdout.truncated,
        "stderr_truncated": stderr.truncated,
        "timed_out": timed_out,
    });
    let failed = timed_out || exit_code != Some(0);
    if failed {
        ToolResult::error(call, content, metadata)
    } else {
        ToolResult::success(call, content, metadata)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Arc;

    use chrono::Utc;
    use tempfile::TempDir;
    use tokio::time::Instant;

    use crate::domain::{GitMetadata, Project, ProjectKind, ThreadId, Workspace, WorkspaceId};

    use super::*;
    use crate::tools::{ProjectBinding, ToolRegistry};

    pub(crate) fn test_context(projects: Vec<ProjectBinding>) -> ToolContext {
        let root = tempfile::tempdir().unwrap().keep();
        let thread_id = ThreadId::new();
        ToolContext::new(
            thread_id,
            crate::domain::TurnId::new(),
            Workspace {
                id: WorkspaceId::new(),
                thread_id,
                root,
                created_at: Utc::now(),
            },
            projects,
            tokio_util::sync::CancellationToken::new(),
        )
    }

    fn project(root: &TempDir, access: ProjectAccess) -> ProjectBinding {
        ProjectBinding::new(
            Project {
                id: ProjectId::new(),
                name: "test-project".to_owned(),
                root: root.path().to_owned(),
                kind: ProjectKind::Directory,
                git: None::<GitMetadata>,
                created_at: Utc::now(),
            },
            access,
        )
    }

    #[tokio::test]
    async fn workspace_file_tools_round_trip_and_list() {
        let context = test_context(Vec::new());
        let registry = ToolRegistry::with_builtins().unwrap();

        let write = ToolCall::new(
            "write-1",
            "write_file",
            json!({ "path": "src/main.rs", "content": "fn main() {}\n" }),
        );
        registry.execute(&write, &context).await.unwrap();

        let read = ToolCall::new("read-1", "read_file", json!({ "path": "src/main.rs" }));
        let result = registry.execute(&read, &context).await.unwrap();
        assert_eq!(result.content, "fn main() {}\n");
        assert!(!result.is_error);

        let list = ToolCall::new("list-1", "list_directory", json!({ "path": "src" }));
        let result = registry.execute(&list, &context).await.unwrap();
        assert_eq!(result.content, "main.rs");
    }

    #[tokio::test]
    async fn absolute_parent_and_symlink_escape_paths_are_rejected() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "hidden")
            .await
            .unwrap();
        let context = test_context(Vec::new());
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), context.workspace.root.join("escape")).unwrap();

        let registry = ToolRegistry::with_builtins().unwrap();
        for path in ["/etc/passwd", "../secret"] {
            let call = ToolCall::new("read", "read_file", json!({ "path": path }));
            assert!(matches!(
                registry.execute(&call, &context).await,
                Err(KodyError::InvalidInput(_))
            ));
        }

        #[cfg(unix)]
        {
            let call = ToolCall::new("read", "read_file", json!({ "path": "escape/secret" }));
            assert!(matches!(
                registry.execute(&call, &context).await,
                Err(KodyError::InvalidInput(_))
            ));
        }
    }

    #[tokio::test]
    async fn read_only_project_allows_reads_but_blocks_write_and_shell() {
        let project_root = tempfile::tempdir().unwrap();
        fs::write(project_root.path().join("README.md"), "hello")
            .await
            .unwrap();
        let binding = project(&project_root, ProjectAccess::ReadOnly);
        let project_id = binding.project.id;
        let context = test_context(vec![binding]);
        let registry = ToolRegistry::with_builtins().unwrap();

        let read = ToolCall::new(
            "read",
            "read_file",
            json!({ "path": "README.md", "project_id": project_id }),
        );
        assert_eq!(
            registry.execute(&read, &context).await.unwrap().content,
            "hello"
        );

        for (name, arguments) in [
            (
                "write_file",
                json!({ "path": "new.txt", "content": "no", "project_id": project_id }),
            ),
            (
                "shell",
                json!({ "command": "pwd", "project_id": project_id }),
            ),
        ] {
            let call = ToolCall::new("mutate", name, arguments);
            assert!(matches!(
                registry.execute(&call, &context).await,
                Err(KodyError::Tool(message)) if message.contains("read-only")
            ));
        }
    }

    #[tokio::test]
    async fn shell_captures_bounded_output_and_nonzero_exit() {
        let context = test_context(Vec::new());
        let registry = ToolRegistry::with_builtins().unwrap();
        let call = ToolCall::new(
            "shell",
            "shell",
            json!({
                "command": "printf 'abcdefgh'; printf 'failure' >&2; exit 7",
                "max_output_bytes": 4
            }),
        );

        let result = registry.execute(&call, &context).await.unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("abcd"));
        assert!(!result.content.contains("abcdefgh"));
        assert!(result.content.contains("fail"));
        assert_eq!(result.metadata["exit_code"], 7);
        assert_eq!(result.metadata["stdout_truncated"], true);
        assert_eq!(result.metadata["stderr_truncated"], true);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_does_not_leave_unmanaged_background_processes() {
        let context = test_context(Vec::new());
        let registry = ToolRegistry::with_builtins().unwrap();
        let call = ToolCall::new(
            "shell-background",
            "shell",
            json!({
                "command": "trap '' HUP; sleep 30 & child=$!; printf '%s\\n' \"$child\""
            }),
        );

        let result = registry.execute(&call, &context).await.unwrap();
        assert!(!result.is_error);
        let child_pid = result
            .content
            .lines()
            .skip_while(|line| *line != "stdout:")
            .nth(1)
            .and_then(|line| line.trim().parse::<i32>().ok())
            .expect("shell should print the background child pid");

        timeout(Duration::from_secs(2), async {
            while pid_is_alive(child_pid) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("foreground shell must clean up background descendants");
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: i32) -> bool {
        // SAFETY: signal zero performs an existence/permission check only.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[test]
    fn shell_environment_drops_credentials_and_sets_workspace_home() {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        command.env("OPENAI_API_KEY", "must-not-leak");

        configure_shell_environment(&mut command, root.path());

        let configured = command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert!(!configured.contains_key("OPENAI_API_KEY"));
        assert_eq!(
            configured.get("HOME"),
            Some(&Some(root.path().to_string_lossy().into_owned()))
        );
        assert_eq!(
            configured.get("CARGO_HOME"),
            Some(&Some(
                root.path()
                    .join(".kody-home/cargo")
                    .to_string_lossy()
                    .into_owned()
            ))
        );
    }

    #[tokio::test]
    async fn shell_honors_cancellation() {
        let context = Arc::new(test_context(Vec::new()));
        let registry = ToolRegistry::with_builtins().unwrap();
        let call = ToolCall::new("shell", "shell", json!({ "command": "sleep 30 & wait" }));
        let cancellation = context.cancellation_token.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(40)).await;
            cancellation.cancel();
        });

        let started = Instant::now();
        let error = registry.execute(&call, &context).await.unwrap_err();
        assert!(matches!(error, KodyError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
