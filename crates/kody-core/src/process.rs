//! Supervision for long-lived, thread-owned background processes.
//!
//! A managed process is intentionally independent from the Turn that starts
//! it. One actor owns each [`tokio::process::Child`], while stdout and stderr
//! are continuously drained into a bounded durable log. Process events use a
//! process-scoped sequence so they can continue after a Turn terminates.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fmt, io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use chrono::Utc;
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{broadcast, mpsc, oneshot, watch, Mutex, RwLock},
    time::Instant,
};

use crate::{
    domain::{
        ManagedProcess, ProcessId, ProcessOrigin, ProcessOutputStream, ProcessStatus, ProjectId,
        ThreadId,
    },
    error::{KodyError, Result},
    event::{ProcessEvent, ProcessEventEnvelope, ProcessEventHub},
    store::StateStore,
};

const LOG_MAGIC: &[u8; 8] = b"KODYPLG1";
const LOG_HEADER_BYTES: usize = LOG_MAGIC.len() + 8 + 8 + 8 + 4;
const LOG_RECORD_HEADER_BYTES: usize = 1 + 8 + 4;

async fn ensure_private_log_directory(path: &Path) -> io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await?;

    // `mode` is still filtered through the process umask. Updating the opened
    // directory also fixes legacy permissions without following a path that
    // could have been replaced with a symlink between checks.
    #[cfg(unix)]
    {
        reject_log_symlink(path).await?;
        let mut options = tokio::fs::OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
        let directory = options.open(path).await?;
        directory
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .await?;
    }
    Ok(())
}

#[cfg(unix)]
async fn reject_log_symlink(path: &Path) -> io::Result<()> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "managed process log path '{}' is a symbolic link",
                path.display()
            ),
        ));
    }
    Ok(())
}

async fn ensure_private_open_log_file(file: &tokio::fs::File) -> io::Result<()> {
    #[cfg(unix)]
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .await?;
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

async fn sync_log_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        reject_log_symlink(path).await?;
        let mut options = tokio::fs::OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
        let directory = options.open(path).await?;
        if let Err(error) = directory.sync_all().await {
            // Some filesystems do not implement directory fsync. The file was
            // still fsynced before rename; ignore only the explicit
            // unsupported cases and surface every other durability failure.
            if !matches!(
                error.raw_os_error(),
                Some(libc::EINVAL) | Some(libc::ENOTSUP)
            ) {
                return Err(error);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Resource and durability limits for [`ProcessManager`].
#[derive(Debug, Clone)]
pub struct ProcessManagerConfig {
    pub log_root: PathBuf,
    pub shell: PathBuf,
    pub max_active_processes: usize,
    pub max_active_processes_per_thread: usize,
    pub max_retained_output_bytes: usize,
    pub max_output_records: usize,
    pub max_read_bytes: usize,
    pub read_chunk_bytes: usize,
    pub output_channel_capacity: usize,
    pub event_capacity: usize,
    pub stop_grace_period: Duration,
    pub status_poll_interval: Duration,
    /// Maximum time allowed for the forked parent-death guardian to confirm
    /// that it has learned the managed process-group id.
    pub guardian_start_timeout: Duration,
    /// Maximum time allowed for stdout/stderr readers (and their logger) to
    /// observe EOF after the managed process group has terminated.
    pub output_shutdown_timeout: Duration,
}

impl ProcessManagerConfig {
    pub fn new(log_root: impl Into<PathBuf>) -> Self {
        Self {
            log_root: log_root.into(),
            shell: PathBuf::from("/bin/sh"),
            max_active_processes: 32,
            max_active_processes_per_thread: 8,
            max_retained_output_bytes: 2 * 1024 * 1024,
            max_output_records: 2_048,
            max_read_bytes: 256 * 1024,
            read_chunk_bytes: 16 * 1024,
            output_channel_capacity: 64,
            event_capacity: 4_096,
            stop_grace_period: Duration::from_secs(3),
            status_poll_interval: Duration::from_millis(25),
            guardian_start_timeout: Duration::from_secs(3),
            output_shutdown_timeout: Duration::from_secs(2),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.log_root.as_os_str().is_empty() {
            return Err(KodyError::InvalidInput(
                "process log root cannot be empty".to_owned(),
            ));
        }
        if self.shell.as_os_str().is_empty() {
            return Err(KodyError::InvalidInput(
                "process shell cannot be empty".to_owned(),
            ));
        }
        for (name, value) in [
            ("max_active_processes", self.max_active_processes),
            (
                "max_active_processes_per_thread",
                self.max_active_processes_per_thread,
            ),
            ("max_retained_output_bytes", self.max_retained_output_bytes),
            ("max_output_records", self.max_output_records),
            ("max_read_bytes", self.max_read_bytes),
            ("read_chunk_bytes", self.read_chunk_bytes),
            ("output_channel_capacity", self.output_channel_capacity),
            ("event_capacity", self.event_capacity),
        ] {
            if value == 0 {
                return Err(KodyError::InvalidInput(format!(
                    "process manager {name} must be greater than zero"
                )));
            }
        }
        if self.stop_grace_period.is_zero()
            || self.status_poll_interval.is_zero()
            || self.guardian_start_timeout.is_zero()
            || self.output_shutdown_timeout.is_zero()
        {
            return Err(KodyError::InvalidInput(
                "process manager timing intervals must be greater than zero".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Everything needed to start a managed command. Environment inheritance is
/// deliberately disabled; callers must pass an already-sanitized environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartProcessRequest {
    pub thread_id: ThreadId,
    pub origin: ProcessOrigin,
    pub project_id: Option<ProjectId>,
    pub command: String,
    pub cwd: PathBuf,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessOutputChunk {
    pub stream: ProcessOutputStream,
    pub cursor: u64,
    pub next_cursor: u64,
    pub bytes: Vec<u8>,
    pub text: String,
}

impl ProcessOutputChunk {
    fn new(stream: ProcessOutputStream, cursor: u64, bytes: Vec<u8>) -> Self {
        let next_cursor = cursor.saturating_add(bytes.len() as u64);
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Self {
            stream,
            cursor,
            next_cursor,
            bytes,
            text,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessOutputPage {
    pub process_id: ProcessId,
    pub requested_cursor: u64,
    pub start_cursor: u64,
    pub next_cursor: u64,
    pub end_cursor: u64,
    pub truncated: bool,
    pub has_more: bool,
    pub chunks: Vec<ProcessOutputChunk>,
}

#[derive(Clone)]
pub struct ProcessManager {
    inner: Arc<ProcessManagerInner>,
}

impl fmt::Debug for ProcessManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessManager")
            .field("config", &self.inner.config)
            .finish_non_exhaustive()
    }
}

struct ProcessManagerInner {
    store: Arc<dyn StateStore>,
    config: Arc<ProcessManagerConfig>,
    events: ProcessEventHub,
    handles: RwLock<HashMap<ProcessId, Arc<ProcessHandle>>>,
    start_lock: Mutex<()>,
    shutting_down: AtomicBool,
}

struct ProcessHandle {
    snapshot: Arc<RwLock<ManagedProcess>>,
    control: Option<mpsc::Sender<ActorCommand>>,
    completion: watch::Receiver<Option<std::result::Result<ManagedProcess, String>>>,
}

enum ActorCommand {
    Stop,
}

impl ProcessManager {
    pub fn new(store: Arc<dyn StateStore>, config: ProcessManagerConfig) -> Result<Self> {
        config.validate()?;
        let events = ProcessEventHub::new(config.event_capacity);
        Ok(Self {
            inner: Arc::new(ProcessManagerInner {
                store,
                config: Arc::new(config),
                events,
                handles: RwLock::new(HashMap::new()),
                start_lock: Mutex::new(()),
                shutting_down: AtomicBool::new(false),
            }),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEventEnvelope> {
        self.inner.events.subscribe()
    }

    pub fn event_hub(&self) -> ProcessEventHub {
        self.inner.events.clone()
    }

    pub fn config(&self) -> &ProcessManagerConfig {
        self.inner.config.as_ref()
    }

    pub fn max_read_bytes(&self) -> usize {
        self.inner.config.max_read_bytes
    }

    pub async fn start(&self, request: StartProcessRequest) -> Result<ManagedProcess> {
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err(process_manager_shutting_down());
        }
        validate_start_request(&request).await?;
        ensure_private_log_directory(&self.inner.config.log_root).await?;

        // Origin uniqueness, quota admission, and startup registration are
        // serialized. The guard is released as soon as the actor reports a
        // durable Running/Failed state; it is never held for process lifetime.
        let _start_guard = self.inner.start_lock.lock().await;
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err(process_manager_shutting_down());
        }
        if let Some(existing) = self
            .inner
            .store
            .get_process_by_origin(&request.origin)
            .await?
        {
            ensure_idempotent_request(&existing, &request)?;
            if let Some(handle) = self.inner.handles.read().await.get(&existing.id).cloned() {
                return Ok(handle.snapshot.read().await.clone());
            }
            if existing.status.is_active() {
                return Err(KodyError::Conflict(format!(
                    "managed process {} belongs to an earlier runtime; recover interrupted processes before starting work",
                    existing.id
                )));
            }
            self.cache_terminal(existing.clone()).await;
            return Ok(existing);
        }

        let active_processes = self.inner.store.list_processes(None).await?;
        let active = active_processes
            .iter()
            .filter(|process| process.status.is_active())
            .count();
        if active >= self.inner.config.max_active_processes {
            return Err(KodyError::Conflict(format!(
                "managed process limit ({}) has been reached",
                self.inner.config.max_active_processes
            )));
        }
        let active_for_thread = active_processes
            .iter()
            .filter(|process| process.thread_id == request.thread_id && process.status.is_active())
            .count();
        if active_for_thread >= self.inner.config.max_active_processes_per_thread {
            return Err(KodyError::Conflict(format!(
                "managed process limit ({}) for thread {} has been reached",
                self.inner.config.max_active_processes_per_thread, request.thread_id
            )));
        }

        let now = Utc::now();
        let process = ManagedProcess {
            id: ProcessId::new(),
            thread_id: request.thread_id,
            origin: request.origin.clone(),
            project_id: request.project_id,
            command: request.command.clone(),
            cwd: request.cwd.clone(),
            spec_fingerprint: process_spec_fingerprint(&request),
            pid: None,
            process_group_id: None,
            status: ProcessStatus::Starting,
            exit_code: None,
            error: None,
            output_truncated: false,
            output_start_cursor: 0,
            output_end_cursor: 0,
            last_event_sequence: 0,
            created_at: now,
            started_at: None,
            completed_at: None,
        };
        let process = self.inner.store.insert_process(process).await?;
        let snapshot = Arc::new(RwLock::new(process.clone()));
        let event_lock = Arc::new(Mutex::new(()));
        let (control_tx, control_rx) = mpsc::channel(8);
        let (started_tx, started_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(None);
        self.inner.handles.write().await.insert(
            process.id,
            Arc::new(ProcessHandle {
                snapshot: snapshot.clone(),
                control: Some(control_tx),
                completion: completion_rx,
            }),
        );

        let actor = ProcessActor {
            store: self.inner.store.clone(),
            config: self.inner.config.clone(),
            events: self.inner.events.clone(),
            snapshot,
            event_lock,
            request,
            control_rx,
            started_tx: Some(started_tx),
            completion_tx,
        };
        tokio::spawn(actor.run());

        started_rx
            .await
            .map_err(|_| KodyError::Tool("managed process actor stopped during startup".into()))?
            .map_err(KodyError::Tool)
    }

    pub async fn list(&self, thread_id: ThreadId) -> Result<Vec<ManagedProcess>> {
        let mut processes = self.inner.store.list_processes(Some(thread_id)).await?;
        let handles = self.inner.handles.read().await;
        for process in &mut processes {
            if let Some(handle) = handles.get(&process.id) {
                *process = handle.snapshot.read().await.clone();
            }
        }
        Ok(processes)
    }

    pub async fn get(&self, process_id: ProcessId) -> Result<ManagedProcess> {
        if let Some(handle) = self.inner.handles.read().await.get(&process_id).cloned() {
            return Ok(handle.snapshot.read().await.clone());
        }
        self.inner.store.get_process(process_id).await
    }

    pub async fn get_for_thread(
        &self,
        thread_id: ThreadId,
        process_id: ProcessId,
    ) -> Result<ManagedProcess> {
        let process = self.get(process_id).await?;
        ensure_process_owner(&process, thread_id)?;
        Ok(process)
    }

    pub async fn read_output(
        &self,
        thread_id: ThreadId,
        process_id: ProcessId,
        cursor: Option<u64>,
        limit: Option<usize>,
    ) -> Result<ProcessOutputPage> {
        let process = self.get_for_thread(thread_id, process_id).await?;
        let limit = limit.unwrap_or(self.inner.config.max_read_bytes);
        if limit == 0 || limit > self.inner.config.max_read_bytes {
            return Err(KodyError::InvalidInput(format!(
                "process output limit must be between 1 and {} bytes",
                self.inner.config.max_read_bytes
            )));
        }
        let log = OutputLog::load(
            &self.log_path(process_id),
            self.inner.config.max_retained_output_bytes,
            self.inner.config.max_output_records,
        )
        .await
        .map_err(|error| {
            KodyError::Store(format!(
                "durable output log for managed process {process_id} is unavailable: {error}"
            ))
        })?;
        if process.output_end_cursor > 0 && log.end_cursor == 0 {
            return Err(KodyError::Store(format!(
                "durable output log for managed process {process_id} is missing"
            )));
        }
        log.read(process.id, cursor, limit)
    }

    pub async fn stop(&self, thread_id: ThreadId, process_id: ProcessId) -> Result<ManagedProcess> {
        let process = self.get_for_thread(thread_id, process_id).await?;
        if process.status.is_terminal() {
            return Ok(process);
        }
        let handle = self
            .inner
            .handles
            .read()
            .await
            .get(&process_id)
            .cloned()
            .ok_or_else(|| {
                KodyError::Conflict(format!(
                    "managed process {process_id} has no actor in this runtime"
                ))
            })?;
        let control = handle.control.as_ref().ok_or_else(|| {
            KodyError::Conflict(format!(
                "managed process {process_id} has no actor in this runtime"
            ))
        })?;
        let _ = control.send(ActorCommand::Stop).await;
        let mut completion = handle.completion.clone();
        loop {
            if let Some(outcome) = completion.borrow().clone() {
                return outcome.map_err(KodyError::Tool);
            }
            completion.changed().await.map_err(|_| {
                KodyError::Tool(format!(
                    "managed process {process_id} actor stopped without a terminal result"
                ))
            })?;
        }
    }

    pub async fn shutdown_all(&self) -> Result<Vec<ManagedProcess>> {
        // Close admission before taking the start barrier. A start that
        // already owns the barrier is allowed to finish registration; once we
        // acquire it, the durable active set is complete and no later start
        // can race behind the shutdown snapshot.
        self.inner.shutting_down.store(true, Ordering::Release);
        let active = {
            let _start_guard = self.inner.start_lock.lock().await;
            self.inner
                .store
                .list_processes(None)
                .await?
                .into_iter()
                .filter(|process| process.status.is_active())
                .collect::<Vec<_>>()
        };
        let outcomes = join_all(
            active
                .into_iter()
                .map(|process| self.stop(process.thread_id, process.id)),
        )
        .await;
        let mut stopped = Vec::with_capacity(outcomes.len());
        let mut errors = Vec::new();
        for outcome in outcomes {
            match outcome {
                Ok(process) => stopped.push(process),
                Err(error) => errors.push(error.to_string()),
            }
        }
        if errors.is_empty() {
            Ok(stopped)
        } else {
            Err(KodyError::Tool(format!(
                "failed to stop every managed process: {}",
                errors.join("; ")
            )))
        }
    }

    /// Marks active records from a previous app-server runtime as lost. PIDs
    /// are retained only as historical metadata and are never signalled or
    /// adopted, which avoids PID-reuse hazards.
    pub async fn recover_interrupted(&self) -> Result<Vec<ManagedProcess>> {
        ensure_private_log_directory(&self.inner.config.log_root).await?;
        if self
            .inner
            .handles
            .read()
            .await
            .values()
            .any(|handle| handle.control.is_some())
        {
            return Err(KodyError::Conflict(
                "cannot recover interrupted processes after actors have started".into(),
            ));
        }

        let records = self.inner.store.list_processes(None).await?;
        let mut recovered = Vec::with_capacity(records.len());
        for mut process in records {
            let log_issue = match OutputLog::load(
                &self.log_path(process.id),
                self.inner.config.max_retained_output_bytes,
                self.inner.config.max_output_records,
            )
            .await
            {
                Ok(log) => {
                    process.output_start_cursor =
                        process.output_start_cursor.max(log.start_cursor());
                    process.output_end_cursor = process.output_end_cursor.max(log.end_cursor);
                    process.output_truncated |= log.start_cursor() > 0;
                    process.last_event_sequence =
                        process.last_event_sequence.max(log.last_event_sequence);
                    None
                }
                Err(error) => Some(format!(
                    "durable output log for managed process {} is unavailable: {error}",
                    process.id
                )),
            };
            if process.status.is_active() {
                let reason = match log_issue.as_ref() {
                    Some(issue) => format!(
                        "process supervision was interrupted by an app-server restart; {issue}"
                    ),
                    None => {
                        "process supervision was interrupted by an app-server restart".to_owned()
                    }
                };
                process.status = ProcessStatus::Lost;
                process.error = Some(reason.clone());
                process.completed_at = Some(Utc::now());
                process.last_event_sequence = process.last_event_sequence.saturating_add(1);
                process = self.inner.store.update_process(process).await?;
                self.inner.events.publish(ProcessEventEnvelope::new(
                    process.thread_id,
                    process.id,
                    process.last_event_sequence,
                    ProcessEvent::Lost { reason },
                ));
            } else if log_issue.is_none() {
                // Valid logs may contain cursor/sequence data that was flushed
                // after the last state snapshot. A missing or corrupt log must
                // leave terminal history untouched and remains available for
                // explicit diagnosis through `read_output`.
                process = self.inner.store.update_process(process).await?;
            }
            self.cache_terminal(process.clone()).await;
            recovered.push(process);
        }
        Ok(recovered)
    }

    fn log_path(&self, process_id: ProcessId) -> PathBuf {
        self.inner
            .config
            .log_root
            .join(format!("{process_id}.plog"))
    }

    async fn cache_terminal(&self, process: ManagedProcess) {
        let (_completion_tx, completion) = watch::channel(Some(Ok(process.clone())));
        self.inner.handles.write().await.insert(
            process.id,
            Arc::new(ProcessHandle {
                snapshot: Arc::new(RwLock::new(process)),
                control: None,
                completion,
            }),
        );
    }
}

fn process_manager_shutting_down() -> KodyError {
    KodyError::Conflict("process manager is shutting down and cannot start new work".into())
}

fn ensure_process_owner(process: &ManagedProcess, thread_id: ThreadId) -> Result<()> {
    if process.thread_id == thread_id {
        Ok(())
    } else {
        Err(KodyError::Conflict(format!(
            "managed process {} belongs to a different thread",
            process.id
        )))
    }
}

async fn validate_start_request(request: &StartProcessRequest) -> Result<()> {
    if request.command.trim().is_empty() {
        return Err(KodyError::InvalidInput(
            "managed process command cannot be empty".into(),
        ));
    }
    if !request.cwd.is_absolute() {
        return Err(KodyError::InvalidInput(
            "managed process cwd must be absolute".into(),
        ));
    }
    let metadata = tokio::fs::metadata(&request.cwd).await?;
    if !metadata.is_dir() {
        return Err(KodyError::InvalidInput(format!(
            "managed process cwd '{}' is not a directory",
            request.cwd.display()
        )));
    }
    if request.origin.tool_call_id.trim().is_empty() {
        return Err(KodyError::InvalidInput(
            "managed process tool_call_id cannot be empty".into(),
        ));
    }
    Ok(())
}

fn ensure_idempotent_request(
    process: &ManagedProcess,
    request: &StartProcessRequest,
) -> Result<()> {
    if process.spec_fingerprint == process_spec_fingerprint(request)
        && process.thread_id == request.thread_id
        && process.project_id == request.project_id
        && process.command == request.command
        && process.cwd == request.cwd
    {
        Ok(())
    } else {
        Err(KodyError::Conflict(format!(
            "managed process origin turn {} tool call '{}' was reused with different parameters",
            request.origin.turn_id, request.origin.tool_call_id
        )))
    }
}

fn process_spec_fingerprint(request: &StartProcessRequest) -> String {
    let mut digest = Sha256::new();
    hash_field(
        &mut digest,
        b"thread",
        request.thread_id.to_string().as_bytes(),
    );
    let project = request
        .project_id
        .map(|id| id.to_string())
        .unwrap_or_default();
    hash_field(&mut digest, b"project", project.as_bytes());
    hash_field(&mut digest, b"command", request.command.as_bytes());
    hash_field(&mut digest, b"cwd", path_bytes(&request.cwd).as_ref());
    for (key, value) in &request.environment {
        hash_field(&mut digest, b"env-key", key.as_bytes());
        hash_field(&mut digest, b"env-value", value.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn hash_field(digest: &mut Sha256, tag: &[u8], value: &[u8]) {
    digest.update((tag.len() as u64).to_le_bytes());
    digest.update(tag);
    digest.update((value.len() as u64).to_le_bytes());
    digest.update(value);
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> std::borrow::Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;

    std::borrow::Cow::Borrowed(path.as_os_str().as_bytes())
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> std::borrow::Cow<'_, [u8]> {
    std::borrow::Cow::Owned(path.to_string_lossy().as_bytes().to_vec())
}

// The guardian is a deliberately tiny forked process. It owns the read end of
// a CLOEXEC lifeline while the app-server owns the write end. The managed
// command registers its process-group id from `pre_exec`, closing the race
// between `Command::spawn` and guardian registration. EOF on the lifeline
// means the app-server died and causes an unconditional SIGKILL of the group;
// an explicit byte disarms the guardian after the actor has observed the group
// terminate. No allocator, Tokio primitive, mutex, or Rust destructor is used
// in the post-fork guardian child.
#[cfg(unix)]
const GUARDIAN_ARMED: u8 = 0xa7;
#[cfg(unix)]
const GUARDIAN_DISARM: u8 = 0xd1;

#[cfg(unix)]
struct ParentDeathGuardian {
    pid: Option<libc::pid_t>,
    registration_write: Option<OwnedFd>,
    acknowledgement_read: Option<OwnedFd>,
    lifeline_write: Option<OwnedFd>,
}

#[cfg(unix)]
impl ParentDeathGuardian {
    fn prepare() -> io::Result<Self> {
        let maximum_descriptor = open_fd_limit()?;
        let (registration_read, registration_write) = cloexec_socketpair()?;
        let (acknowledgement_read, acknowledgement_write) = cloexec_socketpair()?;
        let (lifeline_read, lifeline_write) = cloexec_socketpair()?;

        let registration_read_fd = registration_read.as_raw_fd();
        let registration_write_fd = registration_write.as_raw_fd();
        let acknowledgement_read_fd = acknowledgement_read.as_raw_fd();
        let acknowledgement_write_fd = acknowledgement_write.as_raw_fd();
        let lifeline_read_fd = lifeline_read.as_raw_fd();
        let lifeline_write_fd = lifeline_write.as_raw_fd();

        // SAFETY: after fork the child calls only async-signal-safe libc
        // functions and terminates with `_exit`; it never returns into Rust.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            // SAFETY: all descriptors were created above and remain open in
            // this post-fork child. This function never returns.
            unsafe {
                guardian_child_main(
                    registration_read_fd,
                    registration_write_fd,
                    acknowledgement_read_fd,
                    acknowledgement_write_fd,
                    lifeline_read_fd,
                    lifeline_write_fd,
                    maximum_descriptor,
                )
            }
        }

        drop(registration_read);
        drop(acknowledgement_write);
        drop(lifeline_read);
        Ok(Self {
            pid: Some(pid),
            registration_write: Some(registration_write),
            acknowledgement_read: Some(acknowledgement_read),
            lifeline_write: Some(lifeline_write),
        })
    }

    fn configure_command(&self, command: &mut Command) -> io::Result<()> {
        use std::os::unix::process::CommandExt;

        let registration_fd = self
            .registration_write
            .as_ref()
            .ok_or_else(|| io::Error::other("guardian registration pipe is closed"))?
            .as_raw_fd();
        let acknowledgement_fd = self
            .acknowledgement_read
            .as_ref()
            .ok_or_else(|| io::Error::other("guardian acknowledgement pipe is closed"))?
            .as_raw_fd();
        let lifeline_fd = self
            .lifeline_write
            .as_ref()
            .ok_or_else(|| io::Error::other("guardian lifeline is closed"))?
            .as_raw_fd();

        // SAFETY: the closure contains only close, setpgid, getpid, and write,
        // all of which are async-signal-safe. Captures are plain integers.
        unsafe {
            command.as_std_mut().pre_exec(move || {
                libc::close(lifeline_fd);
                libc::close(acknowledgement_fd);
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                let process_group_id = libc::getpid();
                let registered = send_all_raw(registration_fd, &process_group_id.to_ne_bytes());
                libc::close(registration_fd);
                if registered {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            });
        }
        Ok(())
    }

    async fn confirm_armed(&mut self, timeout: Duration) -> io::Result<()> {
        // The managed child has either registered from pre_exec or failed to
        // spawn, so the owner must no longer keep registration open.
        self.registration_write.take();
        let acknowledgement = self
            .acknowledgement_read
            .take()
            .ok_or_else(|| io::Error::other("guardian acknowledgement was already consumed"))?;
        tokio::task::spawn_blocking(move || read_guardian_ack(acknowledgement, timeout))
            .await
            .map_err(|error| {
                io::Error::other(format!("guardian acknowledgement task failed: {error}"))
            })?
    }

    async fn disarm_and_reap(mut self) -> io::Result<()> {
        self.registration_write.take();
        self.acknowledgement_read.take();
        let write_result = match self.lifeline_write.take() {
            Some(lifeline) => {
                let result = if send_all_raw(lifeline.as_raw_fd(), &[GUARDIAN_DISARM]) {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                };
                drop(lifeline);
                result
            }
            None => Ok(()),
        };
        let Some(pid) = self.pid.take() else {
            return write_result;
        };
        let reap_result = tokio::task::spawn_blocking(move || reap_guardian(pid))
            .await
            .map_err(|error| io::Error::other(format!("guardian reaper task failed: {error}")))?;
        write_result.and(reap_result)
    }
}

#[cfg(unix)]
impl Drop for ParentDeathGuardian {
    fn drop(&mut self) {
        // Dropping without an explicit disarm is the crash/cancellation path:
        // close every owner endpoint, let EOF arm the kill, and reap the small
        // guardian synchronously. The guardian never waits for the managed
        // process, so this waitpid is bounded to a handful of syscalls.
        self.registration_write.take();
        self.acknowledgement_read.take();
        self.lifeline_write.take();
        if let Some(pid) = self.pid.take() {
            let _ = reap_guardian(pid);
        }
    }
}

#[cfg(unix)]
fn cloexec_socketpair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let socket_type = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let socket_type = libc::SOCK_STREAM;
    // SAFETY: `descriptors` points to space for exactly two descriptors.
    let result =
        unsafe { libc::socketpair(libc::AF_UNIX, socket_type, 0, descriptors.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    for descriptor in descriptors {
        // SAFETY: the descriptor was returned by socketpair and is open.
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        if flags < 0
            // SAFETY: F_SETFD receives an integer flag value.
            || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
        {
            let error = io::Error::last_os_error();
            // SAFETY: both descriptors came from the successful socketpair.
            unsafe {
                libc::close(descriptors[0]);
                libc::close(descriptors[1]);
            }
            return Err(error);
        }
    }
    // SAFETY: ownership of both fresh descriptors is transferred exactly once.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    })
}

#[cfg(unix)]
fn send_all_raw(descriptor: RawFd, bytes: &[u8]) -> bool {
    let mut written = 0;
    while written < bytes.len() {
        // SAFETY: the slice is valid for the requested remaining length and
        // MSG_NOSIGNAL makes a vanished peer an EPIPE instead of terminating
        // the app-server or a post-fork child with SIGPIPE.
        let result = unsafe {
            libc::send(
                descriptor,
                bytes[written..].as_ptr().cast(),
                bytes.len() - written,
                libc::MSG_NOSIGNAL,
            )
        };
        if result > 0 {
            written += result as usize;
            continue;
        }
        if result < 0 && raw_errno() == libc::EINTR {
            continue;
        }
        return false;
    }
    true
}

#[cfg(unix)]
unsafe fn guardian_child_main(
    registration_read: RawFd,
    _registration_write: RawFd,
    _acknowledgement_read: RawFd,
    acknowledgement_write: RawFd,
    lifeline_read: RawFd,
    _lifeline_write: RawFd,
    maximum_descriptor: RawFd,
) -> ! {
    let retained = [registration_read, acknowledgement_write, lifeline_read];
    // SAFETY: this is the post-fork child. Closing inherited descriptors and
    // creating a new session use only raw async-signal-safe syscalls. This is
    // essential: retaining a listener, state file, or an older guardian's
    // lifeline would keep unrelated resources alive after the app-server dies.
    unsafe {
        close_inherited_descriptors(maximum_descriptor, &retained);
        if libc::setsid() < 0 {
            libc::_exit(4);
        }
    }

    let mut process_group_bytes = [0_u8; std::mem::size_of::<libc::pid_t>()];
    let registered = read_exact_raw(registration_read, &mut process_group_bytes);
    // SAFETY: no further registration bytes are needed.
    unsafe { libc::close(registration_read) };
    let process_group_id = libc::pid_t::from_ne_bytes(process_group_bytes);
    if !registered || process_group_id <= 0 {
        unsafe {
            libc::close(acknowledgement_write);
            libc::close(lifeline_read);
            libc::_exit(2);
        }
    }

    let acknowledged = send_all_raw(acknowledgement_write, &[GUARDIAN_ARMED]);
    // SAFETY: acknowledgement is a one-shot protocol.
    unsafe { libc::close(acknowledgement_write) };
    if !acknowledged {
        // The group is registered, so a protocol failure must fail closed.
        kill_group_raw(process_group_id);
        unsafe {
            libc::close(lifeline_read);
            libc::_exit(3);
        }
    }

    let mut command = [0_u8; 1];
    // One explicit byte is a clean disarm. EOF, malformed data, or a read
    // error means the owner disappeared and the process group must die.
    let disarmed = read_exact_raw(lifeline_read, &mut command) && command[0] == GUARDIAN_DISARM;
    // SAFETY: the guardian has finished using the lifeline.
    unsafe { libc::close(lifeline_read) };
    if !disarmed {
        kill_group_raw(process_group_id);
    }
    unsafe { libc::_exit(0) }
}

#[cfg(unix)]
fn read_exact_raw(descriptor: RawFd, bytes: &mut [u8]) -> bool {
    let mut read = 0;
    while read < bytes.len() {
        // SAFETY: the mutable slice has room for the requested bytes.
        let result = unsafe {
            libc::read(
                descriptor,
                bytes[read..].as_mut_ptr().cast(),
                bytes.len() - read,
            )
        };
        if result > 0 {
            read += result as usize;
            continue;
        }
        if result < 0 && raw_errno() == libc::EINTR {
            continue;
        }
        return false;
    }
    true
}

#[cfg(unix)]
fn kill_group_raw(process_group_id: libc::pid_t) {
    loop {
        // SAFETY: a positive registered pgid is negated to target the group.
        let result = unsafe { libc::kill(-process_group_id, libc::SIGKILL) };
        if result == 0 || raw_errno() != libc::EINTR {
            return;
        }
    }
}

#[cfg(unix)]
fn open_fd_limit() -> io::Result<RawFd> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: limit points to valid writable storage.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let current = if limit.rlim_cur == libc::RLIM_INFINITY {
        // SAFETY: sysconf has no pointer arguments and does not mutate memory.
        let configured = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
        if configured <= 0 {
            65_536 as libc::rlim_t
        } else {
            configured as libc::rlim_t
        }
    } else {
        limit.rlim_cur
    };
    Ok(current.min(RawFd::MAX as libc::rlim_t) as RawFd)
}

#[cfg(unix)]
unsafe fn close_inherited_descriptors(maximum_descriptor: RawFd, retained: &[RawFd; 3]) {
    // Closing only descriptors known to the guardian is insufficient: fork
    // copies every listener, database file, and other guardian lifeline held
    // by the multithreaded app-server. Walk the pre-fork RLIMIT upper bound and
    // retain only stdio plus the three protocol endpoints.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let mut ordered = *retained;
        ordered.sort_unstable();
        let mut range_start = 3_u32;
        let mut close_range_supported = true;
        for retained_descriptor in ordered
            .into_iter()
            .filter(|descriptor| *descriptor >= 3 && *descriptor < maximum_descriptor)
        {
            let retained_descriptor = retained_descriptor as u32;
            if range_start < retained_descriptor {
                // SAFETY: close_range has scalar arguments and closes only the
                // requested descriptor interval.
                let result = unsafe {
                    libc::syscall(
                        libc::SYS_close_range,
                        range_start,
                        retained_descriptor - 1,
                        0,
                    )
                };
                if result != 0 {
                    close_range_supported = false;
                    break;
                }
            }
            range_start = retained_descriptor.saturating_add(1);
        }
        if close_range_supported && range_start < maximum_descriptor as u32 {
            // SAFETY: arguments are a bounded descriptor interval.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_close_range,
                    range_start,
                    maximum_descriptor as u32 - 1,
                    0,
                )
            };
            close_range_supported = result == 0;
        }
        if close_range_supported {
            return;
        }
    }

    for descriptor in 3..maximum_descriptor {
        if retained.contains(&descriptor) {
            continue;
        }
        // SAFETY: close accepts any integer descriptor; EBADF is expected for
        // unused slots and must be ignored. Never retry close after EINTR.
        unsafe { libc::close(descriptor) };
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn raw_errno() -> libc::c_int {
    // SAFETY: libc returns the calling thread's errno location.
    unsafe { *libc::__errno_location() }
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd"
))]
fn raw_errno() -> libc::c_int {
    // SAFETY: libc returns the calling thread's errno location.
    unsafe { *libc::__error() }
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    ))
))]
fn raw_errno() -> libc::c_int {
    // Fallback for less common Unix libc targets supported by the crate.
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

#[cfg(unix)]
fn read_guardian_ack(acknowledgement: OwnedFd, timeout: Duration) -> io::Result<()> {
    let milliseconds = timeout.as_millis().clamp(1, i32::MAX as u128) as i32;
    let mut poll_descriptor = libc::pollfd {
        fd: acknowledgement.as_raw_fd(),
        events: libc::POLLIN | libc::POLLHUP,
        revents: 0,
    };
    loop {
        // SAFETY: poll receives one initialized pollfd and a bounded timeout.
        let result = unsafe { libc::poll(&mut poll_descriptor, 1, milliseconds) };
        if result > 0 {
            break;
        }
        if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "parent-death guardian did not arm before the startup deadline",
            ));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(error);
        }
    }
    let mut acknowledgement_byte = [0_u8; 1];
    if !read_exact_raw(acknowledgement.as_raw_fd(), &mut acknowledgement_byte) {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "parent-death guardian exited before arming",
        ));
    }
    if acknowledgement_byte[0] != GUARDIAN_ARMED {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "parent-death guardian returned an invalid acknowledgement",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn reap_guardian(pid: libc::pid_t) -> io::Result<()> {
    let mut status = 0;
    loop {
        // SAFETY: pid identifies the direct child created by `fork` and status
        // points to a valid integer.
        let result = unsafe { libc::waitpid(pid, &mut status, 0) };
        if result == pid {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if error.raw_os_error() == Some(libc::ECHILD) {
            return Ok(());
        }
        return Err(error);
    }
}

#[cfg(not(unix))]
struct ParentDeathGuardian;

#[cfg(not(unix))]
impl ParentDeathGuardian {
    fn prepare() -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "parent-death process guardians are not implemented on this platform",
        ))
    }

    fn configure_command(&self, _command: &mut Command) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "parent-death process guardians are not implemented on this platform",
        ))
    }

    async fn confirm_armed(&mut self, _timeout: Duration) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "parent-death process guardians are not implemented on this platform",
        ))
    }

    async fn disarm_and_reap(self) -> io::Result<()> {
        Ok(())
    }
}

struct ProcessActor {
    store: Arc<dyn StateStore>,
    config: Arc<ProcessManagerConfig>,
    events: ProcessEventHub,
    snapshot: Arc<RwLock<ManagedProcess>>,
    event_lock: Arc<Mutex<()>>,
    request: StartProcessRequest,
    control_rx: mpsc::Receiver<ActorCommand>,
    started_tx: Option<oneshot::Sender<std::result::Result<ManagedProcess, String>>>,
    completion_tx: watch::Sender<Option<std::result::Result<ManagedProcess, String>>>,
}

impl ProcessActor {
    async fn run(mut self) {
        let log_path = self
            .config
            .log_root
            .join(format!("{}.plog", self.snapshot.read().await.id));
        let log = OutputLog::empty(
            self.config.max_retained_output_bytes,
            self.config.max_output_records,
        );
        if let Err(error) = log.persist(&log_path).await {
            self.fail_start(format!(
                "failed to initialize process output log '{}': {error}",
                log_path.display()
            ))
            .await;
            return;
        }

        let mut guardian = match ParentDeathGuardian::prepare() {
            Ok(guardian) => guardian,
            Err(error) => {
                self.fail_start(format!(
                    "failed to create parent-death process guardian: {error}"
                ))
                .await;
                return;
            }
        };

        let mut command = Command::new(&self.config.shell);
        command
            .arg("-c")
            .arg(&self.request.command)
            .current_dir(&self.request.cwd)
            .env_clear()
            .envs(&self.request.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Err(error) = guardian.configure_command(&mut command) {
            self.fail_start(error.to_string()).await;
            return;
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                // Closing registration tells a guardian for which no child
                // reached pre_exec that there is nothing to supervise.
                let _ = guardian.disarm_and_reap().await;
                self.fail_start(format!(
                    "failed to spawn managed command '{}': {error}",
                    self.request.command
                ))
                .await;
                return;
            }
        };

        let pid = match child.id() {
            Some(pid) => pid,
            None => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = guardian.disarm_and_reap().await;
                self.fail_start("spawned managed command did not expose a pid".into())
                    .await;
                return;
            }
        };
        let process_group_id = i32::try_from(pid).ok();

        if let Err(error) = guardian
            .confirm_armed(self.config.guardian_start_timeout)
            .await
        {
            if let Some(group_id) = process_group_id {
                let _ = signal_process_group(group_id, libc::SIGKILL);
            } else {
                let _ = child.start_kill();
            }
            let _ = child.wait().await;
            let _ = guardian.disarm_and_reap().await;
            self.fail_after_spawn(format!(
                "managed process parent-death guardian failed to arm: {error}"
            ))
            .await;
            return;
        }

        {
            let mut process = self.snapshot.write().await;
            process.pid = Some(pid);
            process.process_group_id = process_group_id;
            process.status = ProcessStatus::Running;
            process.started_at = Some(Utc::now());
        }
        let running = self.snapshot.read().await.clone();
        if let Err(error) = self.store.update_process(running).await {
            if let Some(group_id) = process_group_id {
                let _ = signal_process_group(group_id, libc::SIGKILL);
            } else {
                let _ = child.start_kill();
            }
            let _ = child.wait().await;
            let _ = guardian.disarm_and_reap().await;
            self.fail_after_spawn(format!(
                "failed to persist managed process startup: {error}"
            ))
            .await;
            return;
        }

        if let Err(error) = persist_and_publish_process_event(
            &self.snapshot,
            &self.event_lock,
            &self.events,
            &self.store,
            ProcessEvent::Started {
                pid,
                process_group_id,
            },
        )
        .await
        {
            if let Some(group_id) = process_group_id {
                let _ = signal_process_group(group_id, libc::SIGKILL);
            } else {
                let _ = child.start_kill();
            }
            let _ = child.wait().await;
            let _ = guardian.disarm_and_reap().await;
            self.fail_after_spawn(format!(
                "failed to persist managed process event sequence: {error}"
            ))
            .await;
            return;
        }
        let running = self.snapshot.read().await.clone();

        if let Some(started_tx) = self.started_tx.take() {
            let _ = started_tx.send(Ok(running));
        }

        let (log_tx, log_rx) = mpsc::channel(self.config.output_channel_capacity);
        let stdout_reader = child.stdout.take().map(|stdout| {
            let sender = log_tx.clone();
            let chunk_bytes = self.config.read_chunk_bytes;
            tokio::spawn(async move {
                drain_stream(stdout, ProcessOutputStream::Stdout, sender, chunk_bytes).await
            })
        });
        let stderr_reader = child.stderr.take().map(|stderr| {
            let sender = log_tx.clone();
            let chunk_bytes = self.config.read_chunk_bytes;
            tokio::spawn(async move {
                drain_stream(stderr, ProcessOutputStream::Stderr, sender, chunk_bytes).await
            })
        });
        drop(log_tx);

        let logger = tokio::spawn(run_output_logger(
            log,
            log_path,
            log_rx,
            self.snapshot.clone(),
            self.event_lock.clone(),
            self.events.clone(),
        ));

        let mut leader_status: Option<ExitStatus> = None;
        let mut lifecycle_error: Option<String> = None;
        let mut stop_requested = false;
        let mut forced = false;
        let mut stop_deadline: Option<Instant> = None;
        let mut control_open = true;

        loop {
            if leader_status.is_none() {
                match child.try_wait() {
                    Ok(status) => leader_status = status,
                    Err(error) => {
                        lifecycle_error =
                            Some(format!("failed to wait for managed process {pid}: {error}"));
                        break;
                    }
                }
            }

            let group_alive = match process_group_id {
                Some(group_id) => match process_group_alive(group_id) {
                    Ok(alive) => alive,
                    Err(error) => {
                        lifecycle_error = Some(format!(
                            "failed to inspect managed process group {group_id}: {error}"
                        ));
                        false
                    }
                },
                None => leader_status.is_none(),
            };
            if leader_status.is_some() && !group_alive {
                break;
            }

            if let Some(deadline) = stop_deadline {
                if Instant::now() >= deadline && !forced {
                    if let Some(group_id) = process_group_id {
                        if let Err(error) = signal_process_group(group_id, libc::SIGKILL) {
                            lifecycle_error.get_or_insert_with(|| {
                                format!("failed to kill managed process group {group_id}: {error}")
                            });
                        }
                    } else if let Err(error) = child.start_kill() {
                        lifecycle_error.get_or_insert_with(|| {
                            format!("failed to kill managed process {pid}: {error}")
                        });
                    }
                    forced = true;
                    stop_deadline = None;
                }
            }

            let delay = stop_deadline
                .map(|deadline| {
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(self.config.status_poll_interval)
                })
                .unwrap_or(self.config.status_poll_interval);
            tokio::select! {
                command = self.control_rx.recv(), if control_open => {
                    match command {
                        Some(ActorCommand::Stop) if !stop_requested => {
                            stop_requested = true;
                            {
                                let mut process = self.snapshot.write().await;
                                process.status = ProcessStatus::Stopping;
                            }
                            if let Err(error) = persist_and_publish_process_event(
                                &self.snapshot,
                                &self.event_lock,
                                &self.events,
                                &self.store,
                                ProcessEvent::Stopping,
                            ).await {
                                lifecycle_error.get_or_insert_with(|| {
                                    format!("failed to persist process stopping state: {error}")
                                });
                            }
                            if let Some(group_id) = process_group_id {
                                if let Err(error) = signal_process_group(group_id, libc::SIGTERM) {
                                    lifecycle_error.get_or_insert_with(|| {
                                        format!("failed to terminate managed process group {group_id}: {error}")
                                    });
                                }
                            } else if let Err(error) = child.start_kill() {
                                lifecycle_error.get_or_insert_with(|| {
                                    format!("failed to terminate managed process {pid}: {error}")
                                });
                            }
                            stop_deadline = Some(Instant::now() + self.config.stop_grace_period);
                        }
                        Some(ActorCommand::Stop) => {}
                        None => control_open = false,
                    }
                }
                _ = tokio::time::sleep(delay) => {}
            }
        }

        if leader_status.is_none() {
            match child.wait().await {
                Ok(status) => leader_status = Some(status),
                Err(error) => {
                    lifecycle_error.get_or_insert_with(|| {
                        format!("failed to reap managed process {pid}: {error}")
                    });
                }
            };
        }

        let reader_errors = collect_reader_errors(
            stdout_reader,
            stderr_reader,
            self.config.output_shutdown_timeout,
        )
        .await;
        if lifecycle_error.is_none() {
            lifecycle_error = reader_errors;
        }
        match collect_logger_error(logger, self.config.output_shutdown_timeout).await {
            Ok(Some(error)) if lifecycle_error.is_none() => lifecycle_error = Some(error),
            Err(error) if lifecycle_error.is_none() => lifecycle_error = Some(error),
            _ => {}
        }

        if let Err(error) = guardian.disarm_and_reap().await {
            lifecycle_error.get_or_insert_with(|| {
                format!("failed to disarm or reap parent-death process guardian: {error}")
            });
        }

        let exit_code = leader_status.and_then(|status| status.code());
        let terminal_event;
        {
            let mut process = self.snapshot.write().await;
            process.exit_code = exit_code;
            process.completed_at = Some(Utc::now());
            if let Some(error) = lifecycle_error.clone() {
                process.status = ProcessStatus::Failed;
                process.error = Some(error.clone());
                terminal_event = ProcessEvent::Failed { error };
            } else if stop_requested {
                process.status = ProcessStatus::Stopped;
                terminal_event = ProcessEvent::Stopped { exit_code, forced };
            } else {
                process.status = ProcessStatus::Exited;
                terminal_event = ProcessEvent::Exited { exit_code };
            }
        }
        let terminal_result = persist_and_publish_process_event(
            &self.snapshot,
            &self.event_lock,
            &self.events,
            &self.store,
            terminal_event,
        )
        .await;

        let terminal = self.snapshot.read().await.clone();
        let outcome = match terminal_result {
            Ok(()) => Ok(terminal),
            Err(error) => Err(error.to_string()),
        };
        let _ = self.completion_tx.send(Some(outcome));
    }

    async fn fail_start(&mut self, error: String) {
        {
            let mut process = self.snapshot.write().await;
            process.status = ProcessStatus::Failed;
            process.error = Some(error.clone());
            process.completed_at = Some(Utc::now());
        }
        let persisted = persist_and_publish_process_event(
            &self.snapshot,
            &self.event_lock,
            &self.events,
            &self.store,
            ProcessEvent::Failed {
                error: error.clone(),
            },
        )
        .await;
        let message = match persisted {
            Ok(()) => error,
            Err(store_error) => format!("{error}; failed to persist failure: {store_error}"),
        };
        if let Some(started_tx) = self.started_tx.take() {
            let _ = started_tx.send(Err(message.clone()));
        }
        let _ = self.completion_tx.send(Some(Err(message)));
    }

    async fn fail_after_spawn(&mut self, error: String) {
        {
            let mut process = self.snapshot.write().await;
            process.status = ProcessStatus::Failed;
            process.error = Some(error.clone());
            process.completed_at = Some(Utc::now());
        }
        let persisted = persist_and_publish_process_event(
            &self.snapshot,
            &self.event_lock,
            &self.events,
            &self.store,
            ProcessEvent::Failed {
                error: error.clone(),
            },
        )
        .await;
        let message = match persisted {
            Ok(()) => error,
            Err(store_error) => format!("{error}; failed to persist failure: {store_error}"),
        };
        if let Some(started_tx) = self.started_tx.take() {
            let _ = started_tx.send(Err(message.clone()));
        }
        let _ = self.completion_tx.send(Some(Err(message)));
    }
}

async fn persist_and_publish_process_event(
    snapshot: &Arc<RwLock<ManagedProcess>>,
    event_lock: &Arc<Mutex<()>>,
    events: &ProcessEventHub,
    store: &Arc<dyn StateStore>,
    event: ProcessEvent,
) -> Result<()> {
    let _guard = event_lock.lock().await;
    let process = {
        let mut process = snapshot.write().await;
        process.last_event_sequence = process.last_event_sequence.saturating_add(1);
        process.clone()
    };
    store.update_process(process.clone()).await?;
    events.publish(ProcessEventEnvelope::new(
        process.thread_id,
        process.id,
        process.last_event_sequence,
        event,
    ));
    Ok(())
}

enum LogInput {
    Data {
        stream: ProcessOutputStream,
        bytes: Vec<u8>,
    },
    ReadError {
        stream: ProcessOutputStream,
        error: String,
    },
}

async fn drain_stream<R>(
    mut reader: R,
    stream: ProcessOutputStream,
    sender: mpsc::Sender<LogInput>,
    chunk_bytes: usize,
) -> Option<String>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0_u8; chunk_bytes];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => return None,
            Ok(read) => {
                if sender
                    .send(LogInput::Data {
                        stream,
                        bytes: buffer[..read].to_vec(),
                    })
                    .await
                    .is_err()
                {
                    return Some(format!("{stream:?} logger closed before EOF"));
                }
            }
            Err(error) => {
                let message = format!("failed to read process {stream:?}: {error}");
                let _ = sender
                    .send(LogInput::ReadError {
                        stream,
                        error: message.clone(),
                    })
                    .await;
                return Some(message);
            }
        }
    }
}

async fn collect_reader_errors(
    stdout: Option<tokio::task::JoinHandle<Option<String>>>,
    stderr: Option<tokio::task::JoinHandle<Option<String>>>,
    shutdown_timeout: Duration,
) -> Option<String> {
    let mut errors = Vec::with_capacity(2);
    let mut readers = [stdout, stderr].into_iter().flatten().collect::<Vec<_>>();
    let deadline = Instant::now() + shutdown_timeout;
    while let Some(mut reader) = readers.pop() {
        match tokio::time::timeout_at(deadline, &mut reader).await {
            Ok(Ok(Some(error))) => errors.push(error),
            Ok(Err(error)) => {
                errors.push(format!("process output reader task failed: {error}"));
            }
            Ok(Ok(None)) => {}
            Err(_) => {
                reader.abort();
                let _ = reader.await;
                for pending in &readers {
                    pending.abort();
                }
                let _ = join_all(readers).await;
                errors.push(format!(
                    "process output readers did not close within {} ms after the process group terminated; a descendant may have escaped the process group while retaining stdout or stderr",
                    shutdown_timeout.as_millis()
                ));
                break;
            }
        }
    }
    (!errors.is_empty()).then(|| errors.join("; "))
}

async fn collect_logger_error(
    mut logger: tokio::task::JoinHandle<Option<String>>,
    shutdown_timeout: Duration,
) -> std::result::Result<Option<String>, String> {
    match tokio::time::timeout(shutdown_timeout, &mut logger).await {
        Ok(Ok(error)) => Ok(error),
        Ok(Err(error)) => Err(format!("process output logger task failed: {error}")),
        Err(_) => {
            logger.abort();
            let _ = logger.await;
            Err(format!(
                "process output logger did not stop within {} ms after its readers closed",
                shutdown_timeout.as_millis()
            ))
        }
    }
}

async fn run_output_logger(
    mut log: OutputLog,
    path: PathBuf,
    mut receiver: mpsc::Receiver<LogInput>,
    snapshot: Arc<RwLock<ManagedProcess>>,
    event_lock: Arc<Mutex<()>>,
    events: ProcessEventHub,
) -> Option<String> {
    let mut first_error = None;
    while let Some(input) = receiver.recv().await {
        match input {
            LogInput::Data { stream, bytes } => {
                let cursor = log.end_cursor;
                log.append(stream, &bytes);
                let _event_guard = event_lock.lock().await;
                let sequence = snapshot.read().await.last_event_sequence.saturating_add(1);
                log.last_event_sequence = sequence;
                match log.persist(&path).await {
                    Ok(()) => {
                        let (thread_id, process_id) = {
                            let mut process = snapshot.write().await;
                            process.output_start_cursor = log.start_cursor();
                            process.output_end_cursor = log.end_cursor;
                            process.output_truncated = log.start_cursor() > 0;
                            process.last_event_sequence = sequence;
                            (process.thread_id, process.id)
                        };
                        let next_cursor = cursor.saturating_add(bytes.len() as u64);
                        events.publish(ProcessEventEnvelope::new(
                            thread_id,
                            process_id,
                            sequence,
                            ProcessEvent::Output {
                                stream,
                                cursor,
                                next_cursor,
                            },
                        ));
                    }
                    Err(error) => {
                        first_error.get_or_insert_with(|| {
                            format!(
                                "failed to persist process output log '{}': {error}",
                                path.display()
                            )
                        });
                    }
                }
            }
            LogInput::ReadError { stream, error } => {
                first_error.get_or_insert_with(|| format!("{stream:?}: {error}"));
            }
        }
    }
    first_error
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OutputRecord {
    stream: ProcessOutputStream,
    cursor: u64,
    bytes: Vec<u8>,
}

impl OutputRecord {
    fn end_cursor(&self) -> u64 {
        self.cursor.saturating_add(self.bytes.len() as u64)
    }
}

#[derive(Debug)]
struct OutputLog {
    records: VecDeque<OutputRecord>,
    end_cursor: u64,
    last_event_sequence: u64,
    retained_bytes: usize,
    max_bytes: usize,
    max_records: usize,
}

impl OutputLog {
    fn empty(max_bytes: usize, max_records: usize) -> Self {
        Self {
            records: VecDeque::new(),
            end_cursor: 0,
            last_event_sequence: 0,
            retained_bytes: 0,
            max_bytes,
            max_records,
        }
    }

    async fn load(path: &Path, max_bytes: usize, max_records: usize) -> Result<Self> {
        // Missing logs are not equivalent to valid empty logs. Every process
        // actor persists an empty header before spawn, so absence is a durable
        // history fault that callers must surface explicitly.
        #[cfg(unix)]
        reject_log_symlink(path).await?;
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(path).await?;
        ensure_private_open_log_file(&file).await?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        Self::decode(&bytes, max_bytes, max_records).map_err(KodyError::Io)
    }

    fn decode(bytes: &[u8], max_bytes: usize, max_records: usize) -> io::Result<Self> {
        if bytes.len() < LOG_HEADER_BYTES || &bytes[..LOG_MAGIC.len()] != LOG_MAGIC {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid managed process output log header",
            ));
        }
        let mut offset = LOG_MAGIC.len();
        let stored_start = read_u64(bytes, &mut offset)?;
        let end_cursor = read_u64(bytes, &mut offset)?;
        let last_event_sequence = read_u64(bytes, &mut offset)?;
        let record_count = read_u32(bytes, &mut offset)? as usize;
        let mut records = VecDeque::with_capacity(record_count.min(max_records));
        let mut retained_bytes = 0_usize;
        let mut expected_cursor = stored_start;
        for _ in 0..record_count {
            let stream = match *bytes.get(offset).ok_or_else(|| {
                io::Error::new(io::ErrorKind::UnexpectedEof, "truncated output stream tag")
            })? {
                0 => ProcessOutputStream::Stdout,
                1 => ProcessOutputStream::Stderr,
                value => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("invalid output stream tag {value}"),
                    ));
                }
            };
            offset += 1;
            let cursor = read_u64(bytes, &mut offset)?;
            let length = read_u32(bytes, &mut offset)? as usize;
            let end = offset.checked_add(length).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "output record length overflow")
            })?;
            let data = bytes.get(offset..end).ok_or_else(|| {
                io::Error::new(io::ErrorKind::UnexpectedEof, "truncated output record")
            })?;
            if cursor != expected_cursor || data.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "managed process output cursors are not contiguous",
                ));
            }
            expected_cursor = cursor.checked_add(length as u64).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "output cursor overflow")
            })?;
            retained_bytes = retained_bytes.checked_add(length).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "output size overflow")
            })?;
            records.push_back(OutputRecord {
                stream,
                cursor,
                bytes: data.to_vec(),
            });
            offset = end;
        }
        if offset != bytes.len() || expected_cursor != end_cursor {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "managed process output log has inconsistent length or end cursor",
            ));
        }

        let mut log = Self {
            records,
            end_cursor,
            last_event_sequence,
            retained_bytes,
            max_bytes,
            max_records,
        };
        log.enforce_limits();
        Ok(log)
    }

    fn append(&mut self, stream: ProcessOutputStream, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let cursor = self.end_cursor;
        self.end_cursor = self.end_cursor.saturating_add(bytes.len() as u64);
        if let Some(last) = self.records.back_mut() {
            if last.stream == stream && last.end_cursor() == cursor {
                last.bytes.extend_from_slice(bytes);
                self.retained_bytes = self.retained_bytes.saturating_add(bytes.len());
                self.enforce_limits();
                return;
            }
        }
        self.records.push_back(OutputRecord {
            stream,
            cursor,
            bytes: bytes.to_vec(),
        });
        self.retained_bytes = self.retained_bytes.saturating_add(bytes.len());
        self.enforce_limits();
    }

    fn enforce_limits(&mut self) {
        while self.records.len() > self.max_records {
            if let Some(record) = self.records.pop_front() {
                self.retained_bytes = self.retained_bytes.saturating_sub(record.bytes.len());
            }
        }
        while self.retained_bytes > self.max_bytes {
            let excess = self.retained_bytes - self.max_bytes;
            let Some(front) = self.records.front_mut() else {
                self.retained_bytes = 0;
                break;
            };
            if front.bytes.len() <= excess {
                let record = self.records.pop_front().expect("front record exists");
                self.retained_bytes = self.retained_bytes.saturating_sub(record.bytes.len());
            } else {
                front.bytes.drain(..excess);
                front.cursor = front.cursor.saturating_add(excess as u64);
                self.retained_bytes -= excess;
            }
        }
    }

    fn start_cursor(&self) -> u64 {
        self.records
            .front()
            .map(|record| record.cursor)
            .unwrap_or(self.end_cursor)
    }

    async fn persist(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            ensure_private_log_directory(parent).await?;
        }
        let bytes = self.encode()?;
        let temporary = path.with_extension("plog.tmp");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(&temporary).await?;
        // `mode` only applies to new files and is umask-filtered. This closes
        // both the legacy-temp-file case and restrictive-umask case without a
        // window that grants group/other access to newly created files.
        ensure_private_open_log_file(&file).await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            sync_log_directory(parent).await?;
        }
        Ok(())
    }

    fn encode(&self) -> io::Result<Vec<u8>> {
        let capacity = LOG_HEADER_BYTES
            .checked_add(self.retained_bytes)
            .and_then(|size| {
                size.checked_add(self.records.len().checked_mul(LOG_RECORD_HEADER_BYTES)?)
            })
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "output log too large"))?;
        let mut bytes = Vec::with_capacity(capacity);
        bytes.extend_from_slice(LOG_MAGIC);
        bytes.extend_from_slice(&self.start_cursor().to_le_bytes());
        bytes.extend_from_slice(&self.end_cursor.to_le_bytes());
        bytes.extend_from_slice(&self.last_event_sequence.to_le_bytes());
        let record_count = u32::try_from(self.records.len()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "too many output log records")
        })?;
        bytes.extend_from_slice(&record_count.to_le_bytes());
        for record in &self.records {
            bytes.push(match record.stream {
                ProcessOutputStream::Stdout => 0,
                ProcessOutputStream::Stderr => 1,
            });
            bytes.extend_from_slice(&record.cursor.to_le_bytes());
            let length = u32::try_from(record.bytes.len()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "output record too large")
            })?;
            bytes.extend_from_slice(&length.to_le_bytes());
            bytes.extend_from_slice(&record.bytes);
        }
        Ok(bytes)
    }

    fn read(
        &self,
        process_id: ProcessId,
        cursor: Option<u64>,
        limit: usize,
    ) -> Result<ProcessOutputPage> {
        let retained_start = self.start_cursor();
        let requested_cursor = cursor.unwrap_or(retained_start);
        if requested_cursor > self.end_cursor {
            return Err(KodyError::InvalidInput(format!(
                "process output cursor {requested_cursor} is past end cursor {}",
                self.end_cursor
            )));
        }
        let start_cursor = requested_cursor.max(retained_start);
        let mut next_cursor = start_cursor;
        let mut remaining = limit;
        let mut chunks = Vec::new();
        for record in &self.records {
            if remaining == 0 || record.end_cursor() <= next_cursor {
                continue;
            }
            if record.cursor > next_cursor {
                return Err(KodyError::Store(format!(
                    "durable output log for managed process {process_id} contains a cursor gap"
                )));
            }
            let offset = (next_cursor - record.cursor) as usize;
            let take = remaining.min(record.bytes.len() - offset);
            let data = record.bytes[offset..offset + take].to_vec();
            chunks.push(ProcessOutputChunk::new(record.stream, next_cursor, data));
            next_cursor = next_cursor.saturating_add(take as u64);
            remaining -= take;
        }
        Ok(ProcessOutputPage {
            process_id,
            requested_cursor,
            start_cursor,
            next_cursor,
            end_cursor: self.end_cursor,
            // `truncated` means this particular request had to be clamped
            // because its cursor was evicted. Whether the process has ever
            // evicted output is carried separately by
            // `ManagedProcess::output_truncated`. Keeping those meanings
            // separate lets clients page forward without discarding earlier
            // pages after the bounded log has wrapped once.
            truncated: requested_cursor < retained_start,
            has_more: next_cursor < self.end_cursor,
            chunks,
        })
    }
}

fn read_u64(bytes: &[u8], offset: &mut usize) -> io::Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "offset overflow"))?;
    let raw: [u8; 8] = bytes
        .get(*offset..end)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "truncated u64"))?
        .try_into()
        .expect("slice length checked");
    *offset = end;
    Ok(u64::from_le_bytes(raw))
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> io::Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "offset overflow"))?;
    let raw: [u8; 4] = bytes
        .get(*offset..end)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "truncated u32"))?
        .try_into()
        .expect("slice length checked");
    *offset = end;
    Ok(u32::from_le_bytes(raw))
}

#[cfg(unix)]
fn signal_process_group(process_group_id: i32, signal: i32) -> io::Result<()> {
    if process_group_id <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process group id must be positive",
        ));
    }
    // SAFETY: `kill` is called with a valid negative process-group id and a
    // platform signal constant. No pointers or shared memory are involved.
    let result = unsafe { libc::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(not(unix))]
fn signal_process_group(_process_group_id: i32, _signal: i32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "managed process groups are not implemented on this platform",
    ))
}

#[cfg(unix)]
fn process_group_alive(process_group_id: i32) -> io::Result<bool> {
    if process_group_id <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process group id must be positive",
        ));
    }
    // SAFETY: signal zero performs an existence/permission check only.
    let result = unsafe { libc::kill(-process_group_id, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error),
    }
}

#[cfg(not(unix))]
fn process_group_alive(_process_group_id: i32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "managed process groups are not implemented on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::Utc;
    use tempfile::TempDir;
    use tokio::time::{sleep, timeout};
    use uuid::Uuid;

    use super::*;
    use crate::{
        domain::{
            Message, MessageId, MessagePart, MessageRole, PermissionMode, Thread, ThreadStatus,
            Turn, TurnId, TurnStatus, Workspace, WorkspaceId,
        },
        event::ProcessEvent,
        store::InMemoryStore,
    };

    struct Fixture {
        _root: TempDir,
        store: Arc<InMemoryStore>,
        thread_id: ThreadId,
        turn_id: TurnId,
        cwd: PathBuf,
        log_root: PathBuf,
    }

    impl Fixture {
        async fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let cwd = root.path().join("workspace");
            let log_root = root.path().join("process-logs");
            tokio::fs::create_dir_all(&cwd).await.unwrap();
            let store = Arc::new(InMemoryStore::new());
            let thread_id = ThreadId::new();
            let workspace_id = WorkspaceId::new();
            let now = Utc::now();
            store
                .insert_thread_with_workspace(
                    Thread {
                        id: thread_id,
                        title: "process test".into(),
                        workspace_id,
                        status: ThreadStatus::Idle,
                        default_references: Vec::new(),
                        summary: None,
                        external_thread_ids: Default::default(),
                        created_at: now,
                        updated_at: now,
                    },
                    Workspace {
                        id: workspace_id,
                        thread_id,
                        root: cwd.clone(),
                        created_at: now,
                    },
                )
                .await
                .unwrap();
            let message_id = MessageId::new();
            store
                .append_message(Message {
                    id: message_id,
                    thread_id,
                    turn_id: None,
                    role: MessageRole::User,
                    parts: vec![MessagePart::Text {
                        text: "start it".into(),
                    }],
                    references: Vec::new(),
                    created_at: now,
                })
                .await
                .unwrap();
            let turn_id = TurnId::new();
            store
                .insert_turn(Turn {
                    id: turn_id,
                    thread_id,
                    input_message_id: message_id,
                    provider: "scripted".into(),
                    model: "test".into(),
                    permission_mode: PermissionMode::Ask,
                    temperature: None,
                    max_output_tokens: None,
                    status: TurnStatus::Completed,
                    created_at: now,
                    started_at: Some(now),
                    completed_at: Some(now),
                    error: None,
                })
                .await
                .unwrap();
            Self {
                _root: root,
                store,
                thread_id,
                turn_id,
                cwd,
                log_root,
            }
        }

        fn config(&self) -> ProcessManagerConfig {
            let mut config = ProcessManagerConfig::new(&self.log_root);
            config.stop_grace_period = Duration::from_millis(150);
            config.status_poll_interval = Duration::from_millis(5);
            config
        }

        fn manager(&self) -> ProcessManager {
            ProcessManager::new(self.store.clone(), self.config()).unwrap()
        }

        fn request(&self, call: &str, command: &str) -> StartProcessRequest {
            StartProcessRequest {
                thread_id: self.thread_id,
                origin: ProcessOrigin {
                    turn_id: self.turn_id,
                    tool_call_id: call.into(),
                },
                project_id: None,
                command: command.into(),
                cwd: self.cwd.clone(),
                environment: BTreeMap::from([
                    ("HOME".into(), self.cwd.display().to_string()),
                    ("PATH".into(), "/usr/bin:/bin".into()),
                ]),
            }
        }

        async fn insert_process_record(
            &self,
            call: &str,
            status: ProcessStatus,
            output_end_cursor: u64,
            last_event_sequence: u64,
        ) -> ManagedProcess {
            let now = Utc::now();
            let terminal = status.is_terminal();
            self.store
                .insert_process(ManagedProcess {
                    id: ProcessId::new(),
                    thread_id: self.thread_id,
                    origin: ProcessOrigin {
                        turn_id: self.turn_id,
                        tool_call_id: call.into(),
                    },
                    project_id: None,
                    command: "persisted command".into(),
                    cwd: self.cwd.clone(),
                    spec_fingerprint: "0".repeat(64),
                    pid: (!terminal).then_some(u32::MAX),
                    process_group_id: (!terminal).then_some(i32::MAX),
                    status,
                    exit_code: (status == ProcessStatus::Exited).then_some(0),
                    error: None,
                    output_truncated: false,
                    output_start_cursor: 0,
                    output_end_cursor,
                    last_event_sequence,
                    created_at: now,
                    started_at: Some(now),
                    completed_at: terminal.then_some(now),
                })
                .await
                .unwrap()
        }
    }

    async fn wait_for_terminal(manager: &ProcessManager, process_id: ProcessId) -> ManagedProcess {
        timeout(Duration::from_secs(10), async {
            loop {
                let process = manager.get(process_id).await.unwrap();
                if process.status.is_terminal() {
                    return process;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("managed process should terminate")
    }

    async fn wait_for_output(
        manager: &ProcessManager,
        thread_id: ThreadId,
        process_id: ProcessId,
    ) -> ProcessOutputPage {
        timeout(Duration::from_secs(5), async {
            loop {
                let page = manager
                    .read_output(thread_id, process_id, None, None)
                    .await
                    .unwrap();
                if page.end_cursor > 0 {
                    return page;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("managed process should produce output")
    }

    #[tokio::test]
    async fn lifecycle_events_are_process_scoped_and_output_is_durable() {
        let fixture = Fixture::new().await;
        let manager = fixture.manager();
        let mut events = manager.subscribe();
        let process = manager
            .start(fixture.request("mixed-output", "printf stdout; printf stderr >&2; exit 7"))
            .await
            .unwrap();
        let terminal = wait_for_terminal(&manager, process.id).await;
        assert_eq!(terminal.status, ProcessStatus::Exited);
        assert_eq!(terminal.exit_code, Some(7));

        let page = manager
            .read_output(fixture.thread_id, process.id, Some(0), None)
            .await
            .unwrap();
        let stdout = page
            .chunks
            .iter()
            .filter(|chunk| chunk.stream == ProcessOutputStream::Stdout)
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect::<Vec<_>>();
        let stderr = page
            .chunks
            .iter()
            .filter(|chunk| chunk.stream == ProcessOutputStream::Stderr)
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(stdout, b"stdout");
        assert_eq!(stderr, b"stderr");
        assert_eq!(page.next_cursor, page.end_cursor);

        let mut received = Vec::new();
        timeout(Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.unwrap();
                assert_eq!(event.process_id, process.id);
                assert_eq!(event.thread_id, fixture.thread_id);
                let terminal = matches!(
                    event.event,
                    ProcessEvent::Exited { .. }
                        | ProcessEvent::Stopped { .. }
                        | ProcessEvent::Failed { .. }
                );
                received.push(event);
                if terminal {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(matches!(received[0].event, ProcessEvent::Started { .. }));
        assert!(received
            .iter()
            .any(|event| matches!(event.event, ProcessEvent::Output { .. })));
        assert!(matches!(
            received.last().unwrap().event,
            ProcessEvent::Exited { exit_code: Some(7) }
        ));
        for (index, event) in received.iter().enumerate() {
            assert_eq!(event.sequence, index as u64 + 1);
        }
    }

    #[tokio::test]
    async fn large_output_is_drained_and_oldest_bytes_are_evicted() {
        let fixture = Fixture::new().await;
        let mut config = fixture.config();
        config.max_retained_output_bytes = 4_096;
        config.read_chunk_bytes = 2_048;
        let manager = ProcessManager::new(fixture.store.clone(), config).unwrap();
        let process = manager
            .start(fixture.request(
                "large-output",
                "/usr/bin/yes 0123456789 | /usr/bin/head -c 262144",
            ))
            .await
            .unwrap();
        let terminal = wait_for_terminal(&manager, process.id).await;
        assert_eq!(terminal.status, ProcessStatus::Exited);
        assert!(terminal.output_truncated);
        assert_eq!(
            terminal.output_end_cursor - terminal.output_start_cursor,
            4_096
        );

        let page = manager
            .read_output(fixture.thread_id, process.id, Some(0), None)
            .await
            .unwrap();
        assert!(page.truncated);
        assert_eq!(page.start_cursor, terminal.output_start_cursor);
        assert_eq!(
            page.chunks
                .iter()
                .map(|chunk| chunk.bytes.len())
                .sum::<usize>(),
            4_096
        );
    }

    #[tokio::test]
    async fn output_log_preserves_invalid_utf8_and_sequence_across_reload() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("output.plog");
        let mut log = OutputLog::empty(4, 8);
        log.append(ProcessOutputStream::Stdout, &[0xff, b'a', b'b']);
        log.append(ProcessOutputStream::Stderr, &[0, b'c', b'd']);
        log.last_event_sequence = 9;
        log.persist(&path).await.unwrap();

        let loaded = OutputLog::load(&path, 4, 8).await.unwrap();
        assert_eq!(loaded.start_cursor(), 2);
        assert_eq!(loaded.end_cursor, 6);
        assert_eq!(loaded.last_event_sequence, 9);
        let page = loaded.read(ProcessId::new(), Some(0), 16).unwrap();
        assert!(page.truncated);
        assert_eq!(page.start_cursor, 2);
        assert_eq!(
            page.chunks
                .iter()
                .flat_map(|chunk| chunk.bytes.iter().copied())
                .collect::<Vec<_>>(),
            vec![b'b', 0, b'c', b'd']
        );

        let retained_page = loaded.read(ProcessId::new(), Some(2), 2).unwrap();
        assert!(!retained_page.truncated);
        assert!(retained_page.has_more);
        assert_eq!(retained_page.next_cursor, 4);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn durable_logs_force_private_directory_and_file_permissions() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = tempfile::tempdir().unwrap();
        let log_root = root.path().join("process-logs");
        tokio::fs::create_dir_all(&log_root).await.unwrap();
        tokio::fs::set_permissions(&log_root, std::fs::Permissions::from_mode(0o777))
            .await
            .unwrap();

        let path = log_root.join("output.plog");
        let temporary = path.with_extension("plog.tmp");
        tokio::fs::write(&temporary, b"legacy temporary contents")
            .await
            .unwrap();
        tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o666))
            .await
            .unwrap();

        OutputLog::empty(32, 8).persist(&path).await.unwrap();
        assert_eq!(
            tokio::fs::metadata(&log_root)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            tokio::fs::metadata(&path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(!temporary.exists());

        // Loading also repairs broader permissions on legacy log files.
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))
            .await
            .unwrap();
        OutputLog::load(&path, 32, 8).await.unwrap();
        assert_eq!(
            tokio::fs::metadata(&path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn durable_logs_reject_symlinks_without_touching_their_targets() {
        use std::os::unix::fs::{symlink, PermissionsExt as _};

        let root = tempfile::tempdir().unwrap();
        let log_root = root.path().join("process-logs");
        ensure_private_log_directory(&log_root).await.unwrap();

        let read_target = root.path().join("read-target");
        tokio::fs::write(&read_target, b"must remain untouched")
            .await
            .unwrap();
        tokio::fs::set_permissions(&read_target, std::fs::Permissions::from_mode(0o666))
            .await
            .unwrap();
        let linked_log = log_root.join("linked.plog");
        symlink(&read_target, &linked_log).unwrap();
        let error = OutputLog::load(&linked_log, 32, 8)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic link"));
        assert_eq!(
            tokio::fs::read(&read_target).await.unwrap(),
            b"must remain untouched"
        );
        assert_eq!(
            tokio::fs::metadata(&read_target)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o666
        );

        let write_target = root.path().join("write-target");
        tokio::fs::write(&write_target, b"must not be truncated")
            .await
            .unwrap();
        let output = log_root.join("output.plog");
        symlink(&write_target, output.with_extension("plog.tmp")).unwrap();
        OutputLog::empty(32, 8).persist(&output).await.unwrap_err();
        assert_eq!(
            tokio::fs::read(&write_target).await.unwrap(),
            b"must not be truncated"
        );
        assert!(!output.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_repairs_legacy_valid_log_permissions() {
        use std::os::unix::fs::PermissionsExt as _;

        let fixture = Fixture::new().await;
        let terminal = fixture
            .insert_process_record("legacy-permissions", ProcessStatus::Exited, 0, 2)
            .await;
        let manager = fixture.manager();
        let path = manager.log_path(terminal.id);
        OutputLog::empty(32, 8).persist(&path).await.unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .await
            .unwrap();

        manager.recover_interrupted().await.unwrap();
        assert_eq!(
            fixture.store.get_process(terminal.id).await.unwrap(),
            terminal
        );
        assert_eq!(
            tokio::fs::metadata(path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn recovery_isolates_missing_logs_and_preserves_terminal_history() {
        let fixture = Fixture::new().await;
        let active = fixture
            .insert_process_record("missing-active", ProcessStatus::Running, 0, 4)
            .await;
        let terminal = fixture
            .insert_process_record("missing-terminal", ProcessStatus::Exited, 12, 8)
            .await;
        let manager = fixture.manager();

        let recovered = manager.recover_interrupted().await.unwrap();
        assert_eq!(recovered.len(), 2);
        let lost = recovered
            .iter()
            .find(|process| process.id == active.id)
            .unwrap();
        assert_eq!(lost.status, ProcessStatus::Lost);
        let reason = lost.error.as_deref().unwrap();
        assert!(reason.contains("app-server restart"));
        assert!(reason.contains("durable output log"));
        assert!(reason.contains("unavailable"));

        assert_eq!(
            fixture.store.get_process(terminal.id).await.unwrap(),
            terminal
        );
        let error = manager
            .read_output(fixture.thread_id, terminal.id, None, None)
            .await
            .unwrap_err();
        let error = error.to_string();
        assert!(error.contains("durable output log"));
        assert!(error.contains("unavailable"));
        assert!(!manager.log_path(active.id).exists());
        assert!(!manager.log_path(terminal.id).exists());
    }

    #[tokio::test]
    async fn recovery_does_not_overwrite_corrupt_logs_or_terminal_records() {
        let fixture = Fixture::new().await;
        let active = fixture
            .insert_process_record("corrupt-active", ProcessStatus::Running, 7, 3)
            .await;
        let terminal = fixture
            .insert_process_record("corrupt-terminal", ProcessStatus::Exited, 9, 6)
            .await;
        let manager = fixture.manager();
        ensure_private_log_directory(&fixture.log_root)
            .await
            .unwrap();
        let corrupt = b"not a managed process log";
        for process_id in [active.id, terminal.id] {
            tokio::fs::write(manager.log_path(process_id), corrupt)
                .await
                .unwrap();
        }

        let recovered = manager.recover_interrupted().await.unwrap();
        let lost = recovered
            .iter()
            .find(|process| process.id == active.id)
            .unwrap();
        assert_eq!(lost.status, ProcessStatus::Lost);
        assert!(lost
            .error
            .as_deref()
            .unwrap()
            .contains("invalid managed process output log header"));
        assert_eq!(
            fixture.store.get_process(terminal.id).await.unwrap(),
            terminal
        );

        for process_id in [active.id, terminal.id] {
            assert_eq!(
                tokio::fs::read(manager.log_path(process_id)).await.unwrap(),
                corrupt
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                assert_eq!(
                    tokio::fs::metadata(manager.log_path(process_id))
                        .await
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
        let error = manager
            .read_output(fixture.thread_id, terminal.id, None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid managed process output log header"));
    }

    #[tokio::test]
    async fn origin_is_idempotent_and_environment_is_part_of_the_spec() {
        let fixture = Fixture::new().await;
        let manager = fixture.manager();
        let request = fixture.request("idempotent", "sleep 30");
        let first = manager.start(request.clone()).await.unwrap();
        let duplicate = manager.start(request.clone()).await.unwrap();
        assert_eq!(first.id, duplicate.id);

        let mut changed = request;
        changed
            .environment
            .insert("MODE".into(), "different".into());
        let error = manager.start(changed).await.unwrap_err();
        assert!(matches!(error, KodyError::Conflict(_)));
        manager.stop(fixture.thread_id, first.id).await.unwrap();
    }

    #[tokio::test]
    async fn per_thread_quota_is_enforced_without_spawning_an_extra_process() {
        let fixture = Fixture::new().await;
        let mut config = fixture.config();
        config.max_active_processes_per_thread = 1;
        let manager = ProcessManager::new(fixture.store.clone(), config).unwrap();
        let first = manager
            .start(fixture.request("quota-1", "sleep 30"))
            .await
            .unwrap();
        let error = manager
            .start(fixture.request("quota-2", "sleep 30"))
            .await
            .unwrap_err();
        assert!(matches!(error, KodyError::Conflict(_)));
        assert_eq!(manager.list(fixture.thread_id).await.unwrap().len(), 1);
        manager.stop(fixture.thread_id, first.id).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_stop_is_idempotent_and_terminates_the_process_group() {
        let fixture = Fixture::new().await;
        let manager = fixture.manager();
        let process = manager
            .start(fixture.request(
                "process-group",
                "sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait",
            ))
            .await
            .unwrap();
        let page = wait_for_output(&manager, fixture.thread_id, process.id).await;
        let child_pid: i32 = page
            .chunks
            .iter()
            .flat_map(|chunk| chunk.text.lines())
            .find_map(|line| line.trim().parse().ok())
            .expect("shell should report its child pid");

        let (left, right) = tokio::join!(
            manager.stop(fixture.thread_id, process.id),
            manager.stop(fixture.thread_id, process.id)
        );
        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(left.id, right.id);
        assert_eq!(left.status, ProcessStatus::Stopped);
        assert_eq!(right.status, ProcessStatus::Stopped);
        assert!(!pid_is_alive(child_pid));
    }

    #[tokio::test]
    async fn shutdown_all_stops_every_active_actor() {
        let fixture = Fixture::new().await;
        let manager = fixture.manager();
        let first = manager
            .start(fixture.request("shutdown-1", "sleep 30"))
            .await
            .unwrap();
        let second = manager
            .start(fixture.request("shutdown-2", "sleep 30"))
            .await
            .unwrap();
        let stopped = manager.shutdown_all().await.unwrap();
        assert_eq!(stopped.len(), 2);
        assert_eq!(
            manager.get(first.id).await.unwrap().status,
            ProcessStatus::Stopped
        );
        assert_eq!(
            manager.get(second.id).await.unwrap().status,
            ProcessStatus::Stopped
        );
    }

    #[tokio::test]
    async fn shutdown_barrier_rejects_every_later_start() {
        let fixture = Fixture::new().await;
        let manager = fixture.manager();
        assert!(manager.shutdown_all().await.unwrap().is_empty());

        let error = manager
            .start(fixture.request("after-shutdown", "sleep 30"))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            KodyError::Conflict(message) if message.contains("shutting down")
        ));
        assert!(manager.list(fixture.thread_id).await.unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn escaped_output_descriptor_fails_within_the_shutdown_deadline() {
        let fixture = Fixture::new().await;
        let mut config = fixture.config();
        config.output_shutdown_timeout = Duration::from_millis(100);
        let manager = ProcessManager::new(fixture.store.clone(), config).unwrap();
        let process = manager
            .start(fixture.request(
                "escaped-output",
                "/usr/bin/python3 -c 'import os,time; os.setsid(); print(os.getpid(), flush=True); time.sleep(30)' & wait",
            ))
            .await
            .unwrap();
        let page = wait_for_output(&manager, fixture.thread_id, process.id).await;
        let escaped_pid: i32 = page
            .chunks
            .iter()
            .flat_map(|chunk| chunk.text.lines())
            .find_map(|line| line.trim().parse().ok())
            .expect("escaped child should report its pid after setsid");

        let stopped = timeout(
            Duration::from_secs(3),
            manager.stop(fixture.thread_id, process.id),
        )
        .await;
        // The escaped test process is intentionally outside the managed group;
        // clean it up before asserting so a failed assertion cannot leak it.
        let _ = signal_process_group(escaped_pid, libc::SIGKILL);

        let terminal = stopped
            .expect("stop must remain bounded when an escaped child retains output")
            .unwrap();
        assert_eq!(terminal.status, ProcessStatus::Failed);
        assert!(terminal.error.as_deref().is_some_and(|error| {
            error.contains("output readers did not close") && error.contains("escaped")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn guardian_detaches_and_does_not_retain_unrelated_descriptors() {
        let (sentinel_read, sentinel_write) = cloexec_socketpair().unwrap();
        let guardian = ParentDeathGuardian::prepare().unwrap();
        let guardian_pid = guardian.pid.expect("guardian pid");
        let owner_group = unsafe { libc::getpgrp() };
        drop(sentinel_write);

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: getpgid is a scalar query for the known child pid.
            let guardian_group = unsafe { libc::getpgid(guardian_pid) };
            if guardian_group == guardian_pid {
                assert_ne!(guardian_group, owner_group);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "guardian did not leave the app-server process group"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        let mut poll_descriptor = libc::pollfd {
            fd: sentinel_read.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        // SAFETY: poll receives one valid descriptor.
        assert!(unsafe { libc::poll(&mut poll_descriptor, 1, 2_000) } > 0);
        let mut byte = [0_u8; 1];
        // EOF proves the guardian did not retain the listener-like write end.
        assert_eq!(
            unsafe { libc::read(sentinel_read.as_raw_fd(), byte.as_mut_ptr().cast(), 1) },
            0
        );
        drop(guardian);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disarm_does_not_deliver_sigpipe_if_guardian_exited_early() {
        let guardian = ParentDeathGuardian::prepare().unwrap();
        let guardian_pid = guardian.pid.expect("guardian pid");
        // SAFETY: this intentionally simulates an unexpected guardian crash.
        assert_eq!(unsafe { libc::kill(guardian_pid, libc::SIGKILL) }, 0);
        sleep(Duration::from_millis(20)).await;
        // Depending on when the peer-close notification reaches the Unix
        // socket, the final byte may either be accepted or return EPIPE. The
        // invariant is that MSG_NOSIGNAL keeps the owner alive in both cases.
        let _ = guardian.disarm_and_reap().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn guardian_kills_registered_group_when_its_owner_dies() {
        // Guardian preparation happens in the normal test owner. Post-fork
        // branches below execute raw syscalls and `_exit` only.
        let mut guardian = ParentDeathGuardian::prepare().unwrap();
        let registration = guardian.registration_write.as_ref().unwrap().as_raw_fd();
        let acknowledgement = guardian.acknowledgement_read.as_ref().unwrap().as_raw_fd();
        let lifeline = guardian.lifeline_write.as_ref().unwrap().as_raw_fd();

        // SAFETY: the worker child performs only close/setpgid/getpid/send and
        // pause, then is terminated by the guardian.
        let worker_pid = unsafe { libc::fork() };
        assert!(worker_pid >= 0, "failed to fork guardian test worker");
        if worker_pid == 0 {
            unsafe {
                libc::close(lifeline);
                libc::close(acknowledgement);
                if libc::setpgid(0, 0) != 0 {
                    libc::_exit(12);
                }
                let process_group_id = libc::getpid();
                if !send_all_raw(registration, &process_group_id.to_ne_bytes()) {
                    libc::_exit(13);
                }
                libc::close(registration);
                loop {
                    libc::pause();
                }
            }
        }
        guardian
            .confirm_armed(Duration::from_secs(2))
            .await
            .unwrap();

        // Transfer the sole lifeline endpoint into a minimal owner child. The
        // parent drops its copy, so this owner's `_exit` is observable as EOF.
        let owner_lifeline = guardian.lifeline_write.take().unwrap();
        // SAFETY: this child immediately exits with one async-signal-safe
        // syscall and never invokes a Rust destructor.
        let owner_pid = unsafe { libc::fork() };
        assert!(owner_pid >= 0, "failed to fork guardian test owner");
        if owner_pid == 0 {
            unsafe { libc::_exit(0) }
        }
        drop(owner_lifeline);

        let owner_status = wait_for_child_exit(owner_pid, Duration::from_secs(2))
            .expect("guardian test owner should exit");
        assert!(libc::WIFEXITED(owner_status));
        assert_eq!(libc::WEXITSTATUS(owner_status), 0);

        let worker_status = wait_for_child_exit(worker_pid, Duration::from_secs(3));
        if worker_status.is_none() {
            let _ = signal_process_group(worker_pid, libc::SIGKILL);
        }
        let worker_status = worker_status.expect("guardian leaked the registered worker group");
        assert!(libc::WIFSIGNALED(worker_status));
        assert_eq!(libc::WTERMSIG(worker_status), libc::SIGKILL);
        guardian.disarm_and_reap().await.unwrap();
    }

    #[tokio::test]
    async fn recovery_marks_old_active_records_lost_without_adopting_their_pid() {
        let fixture = Fixture::new().await;
        let now = Utc::now();
        let process = fixture
            .store
            .insert_process(ManagedProcess {
                id: ProcessId::new(),
                thread_id: fixture.thread_id,
                origin: ProcessOrigin {
                    turn_id: fixture.turn_id,
                    tool_call_id: "old-runtime".into(),
                },
                project_id: None,
                command: "old command".into(),
                cwd: fixture.cwd.clone(),
                spec_fingerprint: "0".repeat(64),
                pid: Some(u32::MAX),
                process_group_id: Some(i32::MAX),
                status: ProcessStatus::Running,
                exit_code: None,
                error: None,
                output_truncated: false,
                output_start_cursor: 0,
                output_end_cursor: 0,
                last_event_sequence: 4,
                created_at: now,
                started_at: Some(now),
                completed_at: None,
            })
            .await
            .unwrap();
        let manager = fixture.manager();
        let mut events = manager.subscribe();
        let recovered = manager.recover_interrupted().await.unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, ProcessStatus::Lost);
        assert_eq!(recovered[0].last_event_sequence, 5);
        let event = events.recv().await.unwrap();
        assert_eq!(event.process_id, process.id);
        assert_eq!(event.sequence, 5);
        assert!(matches!(event.event, ProcessEvent::Lost { .. }));
        assert_eq!(
            manager
                .stop(fixture.thread_id, process.id)
                .await
                .unwrap()
                .status,
            ProcessStatus::Lost
        );
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: i32) -> bool {
        // SAFETY: signal zero only checks whether the numeric pid exists.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(unix)]
    fn wait_for_child_exit(pid: libc::pid_t, timeout: Duration) -> Option<libc::c_int> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let mut status = 0;
            // SAFETY: pid is the direct child created by this test.
            let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if result == pid {
                return Some(status);
            }
            if result < 0 {
                return None;
            }
            if std::time::Instant::now() >= deadline {
                // SAFETY: kill is cleanup for a wedged test child.
                let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
                let _ = unsafe { libc::waitpid(pid, &mut status, 0) };
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn fingerprint_is_stable_and_sensitive_to_environment() {
        let root = PathBuf::from("/tmp");
        let base = StartProcessRequest {
            thread_id: ThreadId(Uuid::from_u128(1)),
            origin: ProcessOrigin {
                turn_id: TurnId(Uuid::from_u128(2)),
                tool_call_id: "call".into(),
            },
            project_id: None,
            command: "serve".into(),
            cwd: root,
            environment: BTreeMap::from([("A".into(), "1".into())]),
        };
        let mut changed = base.clone();
        changed.environment.insert("A".into(), "2".into());
        assert_eq!(process_spec_fingerprint(&base).len(), 64);
        assert_eq!(
            process_spec_fingerprint(&base),
            process_spec_fingerprint(&base)
        );
        assert_ne!(
            process_spec_fingerprint(&base),
            process_spec_fingerprint(&changed)
        );
    }
}
