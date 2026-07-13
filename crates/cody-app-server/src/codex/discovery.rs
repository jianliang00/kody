use std::{
    cmp::Ordering,
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};

use regex::Regex;
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use crate::codex::{
    error::{CodexError, Result},
    redaction::redact_text,
};

const VERSION_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinarySource {
    CodyCodexPath,
    Path,
    ChatGptBundle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexBinary {
    path: PathBuf,
    version: String,
    source: BinarySource,
}

impl CodexBinary {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn source(&self) -> BinarySource {
        self.source
    }

    pub(crate) fn new(path: PathBuf, version: String, source: BinarySource) -> Self {
        Self {
            path,
            version,
            source,
        }
    }
}

/// Binary discovery inputs. An explicit `CODY_CODEX_PATH` is authoritative.
/// Otherwise every PATH and bundle candidate is probed before usable binaries
/// are ranked by their reported Codex semantic version.
#[derive(Debug, Clone)]
pub struct CodexDiscoveryOptions {
    /// Programmatic equivalent of `CODY_CODEX_PATH`. When set, no fallback
    /// binary is selected if this candidate is unusable.
    pub explicit_path: Option<PathBuf>,
    /// PATH override, primarily for controlled hosts and tests.
    pub path: Option<OsString>,
    /// Additional bundle candidates checked after PATH. The standard macOS
    /// ChatGPT location is included by default.
    pub bundle_paths: Vec<PathBuf>,
    pub probe_timeout: Duration,
}

impl Default for CodexDiscoveryOptions {
    fn default() -> Self {
        Self {
            explicit_path: None,
            path: None,
            bundle_paths: vec![PathBuf::from(
                "/Applications/ChatGPT.app/Contents/Resources/codex",
            )],
            probe_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BinaryCandidate {
    pub path: PathBuf,
    pub source: BinarySource,
}

pub(crate) fn candidates(options: &CodexDiscoveryOptions) -> Result<Vec<BinaryCandidate>> {
    if options.probe_timeout.is_zero() {
        return Err(CodexError::InvalidOptions(
            "probe_timeout must be greater than zero".into(),
        ));
    }

    if let Some(path) = options.explicit_path.clone().or_else(env_explicit_path) {
        return Ok(vec![BinaryCandidate {
            path,
            source: BinarySource::CodyCodexPath,
        }]);
    }

    let path = options
        .path
        .clone()
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let mut result = Vec::new();
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(executable_name);
        if is_executable_file(&candidate) {
            result.push(BinaryCandidate {
                path: candidate,
                source: BinarySource::Path,
            });
        }
    }
    for candidate in &options.bundle_paths {
        if is_executable_file(candidate) {
            result.push(BinaryCandidate {
                path: candidate.clone(),
                source: BinarySource::ChatGptBundle,
            });
        }
    }

    let mut seen = HashSet::new();
    result.retain(|candidate| {
        let identity = candidate
            .path
            .canonicalize()
            .unwrap_or_else(|_| candidate.path.clone());
        seen.insert(identity)
    });
    Ok(result)
}

fn env_explicit_path() -> Option<PathBuf> {
    std::env::var_os("CODY_CODEX_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) async fn probe_version(
    candidate: &BinaryCandidate,
    probe_timeout: Duration,
) -> Result<CodexBinary> {
    if !is_executable_file(&candidate.path) {
        return Err(CodexError::BinaryProbe {
            path: candidate.path.clone(),
            reason: "path is not an executable regular file".into(),
        });
    }

    let mut command = Command::new(&candidate.path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|source| CodexError::Spawn {
        path: candidate.path.clone(),
        source,
    })?;
    let stdout = child.stdout.take().expect("piped stdout must exist");
    let stderr = child.stderr.take().expect("piped stderr must exist");
    let stdout_task = tokio::spawn(read_limited(stdout, VERSION_OUTPUT_LIMIT));
    let stderr_task = tokio::spawn(read_limited(stderr, VERSION_OUTPUT_LIMIT));

    let status = match timeout(probe_timeout, child.wait()).await {
        Ok(result) => result.map_err(|source| CodexError::Io {
            operation: "waiting for --version",
            source,
        })?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(CodexError::BinaryProbe {
                path: candidate.path.clone(),
                reason: format!("--version timed out after {probe_timeout:?}"),
            });
        }
    };
    let stdout = join_probe_output(stdout_task, &candidate.path).await?;
    let stderr = join_probe_output(stderr_task, &candidate.path).await?;
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = redact_text(&String::from_utf8_lossy(&stderr));
    if !status.success() {
        return Err(CodexError::BinaryProbe {
            path: candidate.path.clone(),
            reason: format!("--version exited with {status}: {stderr}"),
        });
    }
    let version = redact_text(stdout.trim());
    if version.is_empty() || !version.to_ascii_lowercase().contains("codex") {
        return Err(CodexError::BinaryProbe {
            path: candidate.path.clone(),
            reason: "--version did not identify a Codex executable".into(),
        });
    }

    Ok(CodexBinary::new(
        candidate
            .path
            .canonicalize()
            .unwrap_or_else(|_| candidate.path.clone()),
        version,
        candidate.source,
    ))
}

/// Orders already-probed binaries by compatibility preference. A parseable
/// Codex semantic version always precedes an unparseable version, and newer
/// versions precede older ones. Ties use source and canonical path so discovery
/// does not depend on PATH or bundle enumeration order.
pub(crate) fn sort_by_version_preference(binaries: &mut [CodexBinary]) {
    binaries.sort_by(compare_binary_preference);
}

fn compare_binary_preference(left: &CodexBinary, right: &CodexBinary) -> Ordering {
    match (
        ParsedSemver::from_codex_output(left.version()),
        ParsedSemver::from_codex_output(right.version()),
    ) {
        (Some(left_version), Some(right_version)) => right_version
            .cmp(&left_version)
            .then_with(|| source_rank(left.source()).cmp(&source_rank(right.source())))
            .then_with(|| left.path().cmp(right.path())),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => source_rank(left.source())
            .cmp(&source_rank(right.source()))
            .then_with(|| left.path().cmp(right.path())),
    }
}

fn source_rank(source: BinarySource) -> u8 {
    match source {
        BinarySource::CodyCodexPath => 0,
        BinarySource::Path => 1,
        BinarySource::ChatGptBundle => 2,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<Vec<PrereleaseIdentifier>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PrereleaseIdentifier {
    Numeric(u64),
    Text(String),
}

impl ParsedSemver {
    fn from_codex_output(output: &str) -> Option<Self> {
        static VERSION_PATTERN: OnceLock<Regex> = OnceLock::new();
        let pattern = VERSION_PATTERN.get_or_init(|| {
            Regex::new(
                r"(?:^|[^0-9A-Za-z])v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:$|[^0-9A-Za-z.+-])",
            )
            .expect("the Codex semver pattern is valid")
        });
        let captures = pattern.captures(output)?;
        let major = parse_core_number(captures.get(1)?.as_str())?;
        let minor = parse_core_number(captures.get(2)?.as_str())?;
        let patch = parse_core_number(captures.get(3)?.as_str())?;
        let prerelease = match captures.get(4) {
            Some(value) => Some(
                value
                    .as_str()
                    .split('.')
                    .map(parse_prerelease_identifier)
                    .collect::<Option<Vec<_>>>()?,
            ),
            None => None,
        };

        Some(Self {
            major,
            minor,
            patch,
            prerelease,
        })
    }
}

fn parse_core_number(value: &str) -> Option<u64> {
    if value.len() > 1 && value.starts_with('0') {
        return None;
    }
    value.parse().ok()
}

fn parse_prerelease_identifier(value: &str) -> Option<PrereleaseIdentifier> {
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        if value.len() > 1 && value.starts_with('0') {
            return None;
        }
        value.parse().ok().map(PrereleaseIdentifier::Numeric)
    } else {
        Some(PrereleaseIdentifier::Text(value.to_owned()))
    }
}

impl Ord for ParsedSemver {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then_with(|| self.minor.cmp(&other.minor))
            .then_with(|| self.patch.cmp(&other.patch))
            .then_with(|| compare_prerelease(&self.prerelease, &other.prerelease))
    }
}

impl PartialOrd for ParsedSemver {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_prerelease(
    left: &Option<Vec<PrereleaseIdentifier>>,
    right: &Option<Vec<PrereleaseIdentifier>>,
) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => {
            for (left, right) in left.iter().zip(right) {
                let ordering = match (left, right) {
                    (PrereleaseIdentifier::Numeric(left), PrereleaseIdentifier::Numeric(right)) => {
                        left.cmp(right)
                    }
                    (PrereleaseIdentifier::Numeric(_), PrereleaseIdentifier::Text(_)) => {
                        Ordering::Less
                    }
                    (PrereleaseIdentifier::Text(_), PrereleaseIdentifier::Numeric(_)) => {
                        Ordering::Greater
                    }
                    (PrereleaseIdentifier::Text(left), PrereleaseIdentifier::Text(right)) => {
                        left.cmp(right)
                    }
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            left.len().cmp(&right.len())
        }
    }
}

async fn join_probe_output(
    task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    path: &Path,
) -> Result<Vec<u8>> {
    task.await
        .map_err(|error| CodexError::BinaryProbe {
            path: path.to_owned(),
            reason: format!("output reader failed: {error}"),
        })?
        .map_err(|error| CodexError::BinaryProbe {
            path: path.to_owned(),
            reason: format!("--version output exceeded safety limits or failed: {error}"),
        })
}

async fn read_limited(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    limit: usize,
) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "process output limit exceeded",
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
