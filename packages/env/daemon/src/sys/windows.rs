//! Windows 实现遵循 libuv（`src/win/error.c`、`src/win/process.c`、`src/win/fs.c`）和 Node 的 `child_process` 行为。

use super::{OpenMode, ShellConfig, path_exists, synthetic};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::collections::hash_map::RandomState;
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::FileExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_ALWAYS, CreateFileW, FILE_APPEND_DATA,
    FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_DATA, GetFileInformationByHandle, MOVEFILE_REPLACE_EXISTING, MoveFileExW,
    OPEN_ALWAYS, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// 将文件和进程操作产生的系统错误转换为 libuv 的 `uv_translate_sys_error` 错误代码。
pub fn os_error_name(error: &io::Error) -> &'static str {
    let Some(code) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match code {
        1 => "EISDIR",                             // ERROR_INVALID_FUNCTION
        2 | 3 | 15 | 123 | 161 | 4392 => "ENOENT", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, INVALID_NAME, BAD_PATHNAME, INVALID_REPARSE_DATA
        4 => "EMFILE",                             // ERROR_TOO_MANY_OPEN_FILES
        5 | 1314 => "EPERM",                       // ACCESS_DENIED, PRIVILEGE_NOT_HELD
        6 => "EBADF",                              // ERROR_INVALID_HANDLE
        8 | 14 => "ENOMEM",                        // NOT_ENOUGH_MEMORY, OUTOFMEMORY
        17 => "EXDEV",                             // ERROR_NOT_SAME_DEVICE
        19 => "EROFS",                             // ERROR_WRITE_PROTECT
        32 | 33 => "EBUSY",                        // SHARING_VIOLATION, LOCK_VIOLATION
        39 | 82 | 112 => "ENOSPC",                 // HANDLE_DISK_FULL, CANNOT_MAKE, DISK_FULL
        50 => "ENOTSUP",                           // ERROR_NOT_SUPPORTED
        80 | 183 => "EEXIST",                      // FILE_EXISTS, ALREADY_EXISTS
        13 | 87 | 122 | 131 | 1464 => "EINVAL", // INVALID_DATA, INVALID_PARAMETER, INSUFFICIENT_BUFFER, NEGATIVE_SEEK, SYMLINK_NOT_SUPPORTED
        126 => "ENOENT",                        // ERROR_MOD_NOT_FOUND
        145 => "ENOTEMPTY",                     // ERROR_DIR_NOT_EMPTY
        206 => "ENAMETOOLONG",                  // ERROR_FILENAME_EXCED_RANGE
        267 => "ENOENT",                        // ERROR_DIRECTORY (libuv maps it to ENOENT)
        998 => "EFAULT",                        // ERROR_NOACCESS
        740 | 1920 => "EACCES",                 // ELEVATION_REQUIRED, CANT_ACCESS_FILE
        1921 => "ELOOP",                        // ERROR_CANT_RESOLVE_FILENAME
        _ => "UNKNOWN",
    }
}

pub const PATH_SEPARATOR: &str = "\\";

pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.seek_read(buffer, offset)
}

/// 从纪元起算的修改时间，以秒和纳秒表示；1970 年之前的秒数为负值。
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    let Ok(time) = metadata.modified() else {
        return (0, 0);
    };
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => (after.as_secs() as i64, i64::from(after.subsec_nanos())),
        Err(before) => {
            let before = before.duration();
            let nanos = i64::from(before.subsec_nanos());
            if nanos == 0 {
                (-(before.as_secs() as i64), 0)
            } else {
                (-(before.as_secs() as i64) - 1, 1_000_000_000 - nanos)
            }
        }
    }
}

/// 获取文件索引号需要为每个文件打开句柄；此处改用创建时间区分被替换的文件或目录。
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    use std::os::windows::fs::MetadataExt;
    (0, metadata.creation_time())
}

/// Windows 上 Node 的 `os.tmpdir()`。
pub fn tmpdir() -> String {
    let variable = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    let mut path = variable("TEMP")
        .or_else(|| variable("TMP"))
        .unwrap_or_else(|| {
            format!(
                "{}\\temp",
                variable("SystemRoot")
                    .or_else(|| variable("windir"))
                    .unwrap_or_default()
            )
        });
    if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
        path.pop();
    }
    path
}

/// libuv 的 `uv_os_homedir`：优先使用 `USERPROFILE`。
pub fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

/// 以 NUL 结尾的宽字符路径；路径内含 NUL 时，行为与标准库路径转换失败一致（Node 会在执行系统调用前拒绝此类
/// 路径，客户端也会报告相同错误代码）。
fn wide(text: &str) -> io::Result<Vec<u16>> {
    if text.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL byte",
        ));
    }
    Ok(OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect())
}

/// libuv 的 `fs__mkdtemp`：在 `prefix` 后追加六个 `[a-zA-Z0-9]` 字符；若名称已存在则重新尝试。
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    const CHARACTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let state = RandomState::new();
    for _ in 0..1000 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        let mut random = hasher.finish();
        let mut path = prefix.to_string();
        for _ in 0..6 {
            path.push(CHARACTERS[(random % CHARACTERS.len() as u64) as usize] as char);
            random /= CHARACTERS.len() as u64;
        }
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from_raw_os_error(80))
}

/// Windows 不能将目录作为文件打开，也不支持 `O_NOFOLLOW`；与 `NodeExecutionEnv` 一样，先检查路径
///（此检查无法避免竞态）。
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    if no_follow
        && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path));
    }
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    File::open(path).map_err(|error| Failure::io(&error, "open", path))
}

/// 对应 Node 写入模式下 libuv 的 `fs__open`：使用相应的访问权限、共享方式和打开选项调用 `CreateFileW`，始终设置
/// `FILE_FLAG_BACKUP_SEMANTICS`，使目录可以打开，但后续操作会像 Node 一样失败；若尝试在已有目录的位置创建文件，则返回
/// `EISDIR`。（Rust 的 `File::create` 使用 `OPEN_ALWAYS` 打开，然后再截断文件。）
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let (access, disposition) = match mode {
        OpenMode::Read => (FILE_GENERIC_READ, OPEN_EXISTING),
        OpenMode::Write => (FILE_GENERIC_WRITE, CREATE_ALWAYS),
        OpenMode::Append => (
            (FILE_GENERIC_WRITE & !FILE_WRITE_DATA) | FILE_APPEND_DATA,
            OPEN_ALWAYS,
        ),
        OpenMode::ReadWrite => (FILE_GENERIC_READ | FILE_GENERIC_WRITE, OPEN_EXISTING),
    };
    let name = wide(path)?;
    // 安全性：路径以 NUL 结尾；成功时返回的句柄由 File 接管。
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        // 创建时收到 ERROR_FILE_EXISTS，表示该路径是目录。
        if error.raw_os_error() == Some(80) && matches!(mode, OpenMode::Write | OpenMode::Append) {
            return Err(synthetic("EISDIR"));
        }
        return Err(error);
    }
    // 安全性：`handle` 是有效且由当前代码拥有的文件句柄。
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

/// libuv 的 `uv_fs_realpath`：返回不带 `\\?\` 前缀的最终路径。
pub fn realpath(path: &str) -> io::Result<String> {
    let resolved = std::fs::canonicalize(path)?.to_string_lossy().into_owned();
    Ok(if let Some(unc) = resolved.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        resolved
            .strip_prefix("\\\\?\\")
            .map(str::to_string)
            .unwrap_or(resolved)
    })
}

/// libuv 的 `fs__rename`：调用 `MoveFileExW` 并替换已存在的目标。
pub fn rename(from: &str, to: &str) -> io::Result<()> {
    let (from, to) = (wide(from)?, wide(to)?);
    // 安全性：两个参数都是 NUL 结尾的宽字符串，且其生命周期覆盖整个调用。
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Windows 上 Node 的 `rm` 行为：指向目录的符号链接或目录联接按目录项删除（对应 libuv 的
/// `fs__unlink`）；只读文件会在取消只读属性后重试删除。
pub fn remove_file(path: &str) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink_dir()) {
        return std::fs::remove_dir(path);
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = std::fs::metadata(path)?.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
            std::fs::remove_file(path)
        }
        other => other,
    }
}

/// 读取线程通过阻塞调用读取的管道；`interrupt_reader` 可取消阻塞的读取操作。
pub trait Pipe: io::Read {}
impl<T: io::Read> Pipe for T {}

/// 持续读取 `pipe`，直到管道结束、`on_data` 返回 false 或 `stop` 被设置；函数返回时关闭管道。
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
    let mut buffer = vec![0u8; 64 * 1024];
    while !stop.load(Ordering::SeqCst) {
        match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if !on_data(&buffer[..read]) {
                    return;
                }
            }
        }
    }
}

/// 取消阻塞在 `ReadFile` 中的读取线程，使其检查到 `stop` 并关闭管道。
pub fn interrupt_reader(reader: &std::thread::JoinHandle<()>) {
    // 安全性：句柄属于仍在运行或已结束的线程；没有待处理 I/O 时取消操作不会产生影响。
    unsafe {
        CancelSynchronousIo(reader.as_raw_handle() as _);
    }
}

/// argv 命令使用 libuv 的 `search_path`：名称包含目录时按原样尝试，否则依次搜索工作目录和各个 `PATH` 条目；
/// 名称没有扩展名时还会尝试 `.com` 和 `.exe`。Node 不允许在没有 Shell 的情况下运行批处理文件。
pub fn resolve_program(
    program: &str,
    cwd: &str,
    env: &Map<String, Value>,
) -> Result<String, Failure> {
    let not_found = || Failure::new("spawn_error", format!("spawn {program} ENOENT"));
    let has_extension = Path::new(program).extension().is_some();
    let candidates = |base: &Path| -> Vec<std::path::PathBuf> {
        let mut names = Vec::new();
        if has_extension {
            names.push(base.to_path_buf());
        }
        for extension in ["com", "exe"] {
            let mut name = base.as_os_str().to_owned();
            name.push(".");
            name.push(extension);
            names.push(name.into());
        }
        names
    };
    let found = if program.contains(['\\', '/', ':']) {
        candidates(&Path::new(cwd).join(program))
            .into_iter()
            .find(|path| path.is_file())
    } else {
        let path_variable = env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .and_then(|(_, value)| value.as_str().map(str::to_string))
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        std::iter::once(std::path::PathBuf::from(cwd))
            .chain(std::env::split_paths(&path_variable))
            .flat_map(|directory| candidates(&directory.join(program)))
            .find(|path| path.is_file())
    };
    let found = found.ok_or_else(not_found)?;
    let lower = found.to_string_lossy().to_lowercase();
    if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        return Err(Failure::new(
            "spawn_error",
            format!("spawn {program} EINVAL"),
        ));
    }
    Ok(found.to_string_lossy().into_owned())
}

/// Node 的 `isLegacyWslBashPath`：不区分大小写地匹配 `^[a-z]:\\windows\\(system32|sysnative)\\bash\.exe$`。
fn is_legacy_wsl_bash(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_lowercase();
    let mut characters = normalized.chars();
    characters
        .next()
        .is_some_and(|drive| drive.is_ascii_lowercase())
        && matches!(
            characters.as_str(),
            ":\\windows\\system32\\bash.exe" | ":\\windows\\sysnative\\bash.exe"
        )
}

fn bash_config(program: &str) -> ShellConfig {
    if is_legacy_wsl_bash(program) {
        ShellConfig {
            program: program.into(),
            args: vec!["-s".into()],
            command_on_stdin: true,
        }
    } else {
        ShellConfig {
            program: program.into(),
            args: vec!["-c".into()],
            command_on_stdin: false,
        }
    }
}

fn where_bash() -> Option<String> {
    let output = Command::new("where")
        .arg("bash.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()?
        .trim()
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node 在 Windows 上的 Shell 解析顺序：已配置的 Shell、Git Bash、`where bash.exe`，否则返回 `shell_unavailable`。
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(bash_config(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(directory) = std::env::var(variable) {
            candidates.push(format!("{directory}\\Git\\bin\\bash.exe"));
        }
    }
    if let Some(found) = candidates.iter().find(|candidate| path_exists(candidate)) {
        return Ok(bash_config(found));
    }
    if let Some(found) = where_bash() {
        return Ok(bash_config(&found));
    }
    let searched: String = candidates
        .iter()
        .map(|candidate| format!("  {candidate}\n"))
        .collect();
    Err(Failure::new(
        "shell_unavailable",
        format!(
            "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Configure an explicit shellPath\n\nSearched Git Bash in:\n{}",
            searched.trim_end()
        ),
    ))
}

/// libuv 的 `quote_cmd_arg`：将单个参数写入命令行，以便子进程再次拆分时还原出原参数。
pub fn quote_argument(argument: &str) -> String {
    if argument.is_empty() {
        return "\"\"".into();
    }
    if !argument.contains([' ', '\t', '"']) {
        return argument.into();
    }
    if !argument.contains(['"', '\\']) {
        return format!("\"{argument}\"");
    }
    // 从后向前处理：引号前（或结束引号前）的反斜杠数量加倍，同时转义引号。
    let mut reversed = Vec::new();
    let mut quote_hit = true;
    for character in argument.chars().rev() {
        reversed.push(character);
        if quote_hit && character == '\\' {
            reversed.push('\\');
        } else if character == '"' {
            quote_hit = true;
            reversed.push('\\');
        } else {
            quote_hit = false;
        }
    }
    let mut quoted = String::from("\"");
    quoted.extend(reversed.into_iter().rev());
    quoted.push('"');
    quoted
}

/// libuv 会从父进程复制到子进程环境中、且子进程尚未设置的变量。
const REQUIRED_VARIABLES: [&str; 11] = [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

/// Node 在 Windows 上构建的子进程环境：按对象顺序读取变量，并按 UTF-16 代码单元排序；仅大小写不同的变量名保留首个；
/// 随后 libuv 会补入结果中缺失的必需变量。
fn child_environment(env: &Map<String, Value>, inherit_env: bool) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut set =
        |key: String, value: String| match entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key, value)),
        };
    if inherit_env {
        for (key, value) in std::env::vars_os() {
            set(
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            set(key.clone(), value.to_string());
        }
    }
    entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let mut seen = std::collections::HashSet::new();
    entries.retain(|(name, _)| seen.insert(name.to_uppercase()));
    for required in REQUIRED_VARIABLES {
        if !entries
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(required))
            && let Ok(value) = std::env::var(required)
        {
            entries.push((required.to_string(), value));
        }
    }
    entries
}

/// 按 libuv 规则转义的参数、Node 环境变量，以及隐藏的控制台。
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    for argument in args {
        command.raw_arg(quote_argument(argument));
    }
    command.env_clear();
    for (key, value) in child_environment(env, inherit_env) {
        command.env(key, value);
    }
    command.creation_flags(CREATE_NO_WINDOW);
}

/// libuv 会将启动的所有子进程放入同一个作业对象；守护进程退出时，该对象会终止其中的进程。
fn job() -> Option<isize> {
    static JOB: OnceLock<Option<isize>> = OnceLock::new();
    *JOB.get_or_init(|| {
        // 安全性：使用已清零且大小正确的信息结构调用普通 Win32 函数。
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
                | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(job as isize)
        }
    })
}

pub fn after_spawn(child: &Child) {
    if let Some(job) = job() {
        // 安全性：两个句柄在整个调用期间均有效。
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

/// Windows 上 Node 的 `killProcessTree` 行为：调用 `taskkill /F /T`，但不等待其完成。
pub fn kill_tree(pid: u32) {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let _ = Command::new(format!("{system_root}\\System32\\taskkill.exe"))
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Windows 退出码是 32 位无符号值（访问冲突的退出码为 3221225477）。
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(status.code().unwrap_or(1) as u32)
}

/// Windows 目录列表保留文件系统顺序；不会按原始名称排序。
pub fn raw_name(_name: &OsStr) -> Option<Vec<u8>> {
    None
}

/// `=C:` 等变量记录的各盘符工作目录，Node 的 `path.resolve` 会用它们解析相对盘符的路径。
pub fn drive_cwds() -> Map<String, Value> {
    std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_str()?;
            let bytes = key.as_bytes();
            (bytes.len() == 3
                && bytes[0] == b'='
                && bytes[1].is_ascii_alphabetic()
                && bytes[2] == b':')
                .then(|| {
                    (
                        key[1..].to_ascii_uppercase(),
                        Value::String(value.to_string_lossy().into_owned()),
                    )
                })
        })
        .collect()
}

/// libuv 的 `scandir` 和 `opendir` 在路径指向文件时返回 `ENOTDIR`（其他情况下 `ERROR_DIRECTORY` 对应 `ENOENT`）。
pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path).map_err(|error| {
        if error.raw_os_error() == Some(267) {
            synthetic("ENOTDIR")
        } else {
            error
        }
    })
}

/// `path` 的卷序列号和文件索引，分别对应 libuv `stat` 返回的 `dev` 和 `ino`：仅凭创建时间不足以识别文件，
/// 因为 NTFS 可能将近期删除名称下创建的文件赋予旧文件的创建时间（“隧道效应”）。
/// 与 libuv 一样打开句柄；路径无法打开时回退使用元数据。
pub fn path_identity(path: &str, metadata: &Metadata, follow: bool) -> (u64, u64) {
    let Ok(name) = wide(path) else {
        return identity(metadata);
    };
    let flags = FILE_FLAG_BACKUP_SEMANTICS
        | if follow {
            0
        } else {
            FILE_FLAG_OPEN_REPARSE_POINT
        };
    // 安全性：路径以 NUL 结尾；句柄会在下方关闭。
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return identity(metadata);
    }
    // 安全性：句柄有效，并提供已清零、供函数填充的缓冲区。
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let found = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
    // 安全性：使用上方打开的句柄。
    unsafe { CloseHandle(handle) };
    if !found {
        return identity(metadata);
    }
    (
        u64::from(information.dwVolumeSerialNumber),
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    )
}

#[cfg(test)]
mod tests {
    use super::quote_argument;

    #[test]
    fn quotes_arguments_like_libuv() {
        assert_eq!(quote_argument(""), "\"\"");
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("a b"), "\"a b\"");
        assert_eq!(quote_argument("*.txt"), "*.txt");
        assert_eq!(quote_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(
            quote_argument("C:\\dir with space\\"),
            "\"C:\\dir with space\\\\\""
        );
        assert_eq!(quote_argument("a\\\\b c"), "\"a\\\\b c\"");
    }
}
