//! Linux、macOS 和 Android。

use super::{OpenMode, ShellConfig, path_exists};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// libuv 对应的操作系统错误名称。
pub fn os_error_name(error: &io::Error) -> &'static str {
    let Some(errno) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match errno {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => "UNKNOWN",
    }
}

pub const PATH_SEPARATOR: &str = "/";

pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(buffer, offset)
}

/// 从纪元起算的修改时间，以秒和纳秒表示。
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    (metadata.mtime(), metadata.mtime_nsec())
}

/// 用设备号和 inode 标识文件，即使文件被重命名也能识别。
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Node 的 `os.tmpdir()`；Termux 上的 Node 会回退到 `$PREFIX/tmp`。
pub fn tmpdir() -> String {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()));
    let mut path = configured.unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            format!(
                "{}/tmp",
                std::env::var("PREFIX")
                    .unwrap_or_else(|_| "/data/data/com.termux/files/usr".into())
            )
        } else {
            "/tmp".into()
        }
    });
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// 对 `prefix` 调用 libuv 使用的 `mkdtemp(3)`：追加六个从 `[A-Za-z0-9]` 中随机选取的字符。
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    let mut template = prefix.as_bytes().to_vec();
    template.extend_from_slice(b"XXXXXX");
    let template =
        CString::new(template).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut buffer = template.into_bytes_with_nul();
    // 安全性：`buffer` 是以 NUL 结尾且可写的模板，mkdtemp 会就地填入随机字符。
    let created = unsafe { libc::mkdtemp(buffer.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    buffer.pop();
    Ok(OsStr::from_bytes(&buffer).to_string_lossy().into_owned())
}

/// 打开普通文件以进行定位读取；不会因 FIFO 阻塞，设置 `no_follow` 时也不会跟随
/// 最终路径分量上的符号链接。
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    let mut flags = libc::O_NONBLOCK;
    if no_follow {
        flags |= libc::O_NOFOLLOW;
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|error| {
            if no_follow && matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
                Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path)
            } else {
                Failure::io(&error, "open", path)
            }
        })
}

/// 使用 Node 的一种写入模式打开文件。
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let mut options = OpenOptions::new();
    match mode {
        OpenMode::Read => options.read(true),
        OpenMode::Write => options.write(true).create(true).truncate(true),
        OpenMode::Append => options.append(true).create(true),
        OpenMode::ReadWrite => options.read(true).write(true),
    };
    options.open(path)
}

pub fn realpath(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|resolved| resolved.to_string_lossy().into_owned())
}

pub fn rename(from: &str, to: &str) -> io::Result<()> {
    std::fs::rename(from, to)
}

pub fn remove_file(path: &str) -> io::Result<()> {
    std::fs::remove_file(path)
}

/// 供读取线程轮询的管道；命令结束时线程可以停止读取。
pub trait Pipe: io::Read + std::os::fd::AsRawFd {}
impl<T: io::Read + std::os::fd::AsRawFd> Pipe for T {}

/// 持续读取 `pipe`，直到管道结束、`on_data` 返回 false 或 `stop` 被设置；函数返回时关闭管道。
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
    let fd = pipe.as_raw_fd();
    // 安全性：对当前线程拥有的文件描述符调用 fcntl。
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let mut buffer = vec![0u8; 64 * 1024];
    while !stop.load(Ordering::SeqCst) {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // 安全性：传入一个有效的 pollfd。
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready == 0
            || (ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted)
        {
            continue;
        }
        if ready < 0 {
            return;
        }
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                if !on_data(&buffer[..read]) {
                    return;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return,
        }
    }
}

/// 读取线程每 100 毫秒检查一次 `stop`。
pub fn interrupt_reader(_reader: &std::thread::JoinHandle<()>) {}

/// argv 命令要运行的程序；`Command` 会像 libuv 一样通过 `execvp` 的方式搜索 `PATH`。
pub fn resolve_program(
    program: &str,
    _cwd: &str,
    _env: &Map<String, Value>,
) -> Result<String, Failure> {
    Ok(program.to_string())
}

fn which_bash() -> Option<String> {
    let output = Command::new("which")
        .arg("bash")
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
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node 的 Shell 解析顺序：配置的 Shell 必须存在；否则依次尝试 `/bin/bash`、`which bash`，最后使用 `sh`。
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    let shell = |program: &str| ShellConfig {
        program: program.into(),
        args: vec!["-c".into()],
        command_on_stdin: false,
    };
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(shell(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    if path_exists("/bin/bash") {
        return Ok(shell("/bin/bash"));
    }
    Ok(shell(&which_bash().unwrap_or_else(|| "sh".into())))
}

/// 按 libuv 的行为设置参数、环境变量和进程。
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    command.args(args);
    if !inherit_env {
        command.env_clear();
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            command.env(key, value);
        }
    }
    // 安全性：fork 和 exec 之间只调用异步信号安全的函数。
    unsafe {
        command.pre_exec(|| {
            // 创建新会话，使终止信号能到达所有后代进程；按 libuv 的方式使用默认信号处理并清空信号屏蔽集。
            libc::setsid();
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}

pub fn after_spawn(_child: &Child) {}

/// 终止命令所在的进程组；若进程组已不存在，则终止该进程。
pub fn kill_tree(pid: u32) {
    let pid = pid as i32;
    // 安全性：仅发送信号。
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// 被信号终止的进程没有退出码；按 Shell 的做法返回 128 加信号编号。
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
    )
}

/// 文件名的字节；libuv 按此对目录列表排序。
pub fn raw_name(name: &OsStr) -> Option<Vec<u8>> {
    Some(name.as_bytes().to_vec())
}

/// 仅 Windows：`=C:` 等变量所表示的各盘符当前工作目录。
pub fn drive_cwds() -> Map<String, Value> {
    Map::new()
}

pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path)
}

/// `path` 的设备号和 inode；元数据中已包含这些值。
pub fn path_identity(_path: &str, metadata: &Metadata, _follow: bool) -> (u64, u64) {
    identity(metadata)
}
