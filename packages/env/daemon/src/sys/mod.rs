//! 各操作系统间存在差异的行为：错误名称、定位读取、临时目录、打开读取句柄，
//! 以及启动和终止命令。各实现均遵循 Node（libuv）在对应系统上的行为。

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// 字符串命令的运行方式：使用的 Shell、命令前的参数，以及命令是否通过其
/// 标准输入传递，而不是作为参数传递（旧版 WSL `bash.exe`）。
pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
    pub command_on_stdin: bool,
}

/// Node 打开文件的方式：`r`、`writeFile`（`w`）、`appendFile`（`a`），以及用于截断和 fsync 的 `r+`。
#[derive(Clone, Copy)]
pub enum OpenMode {
    /// Node 的 `open(path, "r")`：允许打开任意类型的文件，读取时会阻塞。
    Read,
    Write,
    Append,
    ReadWrite,
}

/// 当系统调用报告的错误与 libuv 返回的错误代码不同时使用，例如递归 `mkdir` 路径经过文件时返回 `ENOTDIR`，
/// 或 Windows 在目录已存在的位置创建文件时返回 `EISDIR`。
#[derive(Debug)]
pub struct Synthetic(pub &'static str);

impl std::fmt::Display for Synthetic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for Synthetic {}

pub fn synthetic(code: &'static str) -> std::io::Error {
    std::io::Error::other(Synthetic(code))
}

/// 错误的 libuv 名称：合成错误代码，或按平台转换后的系统错误代码。
pub fn error_name(error: &std::io::Error) -> &'static str {
    if let Some(Synthetic(code)) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Synthetic>())
    {
        return code;
    }
    os_error_name(error)
}

/// 跟随符号链接检查路径是否存在，与 Node 的 `access(path, F_OK)` 一致。
pub fn path_exists(path: &str) -> bool {
    std::path::Path::new(path).metadata().is_ok()
}

/// 用于临时名称的 16 个随机字节（不用于机密信息）。
pub fn random_bytes() -> [u8; 16] {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let state = std::collections::hash_map::RandomState::new();
    let mut bytes = [0u8; 16];
    for half in 0..2 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|time| time.as_nanos())
                .unwrap_or(0),
        );
        bytes[half * 8..half * 8 + 8].copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes
}

/// 守护进程的工作目录；Node 的 `path.resolve` 会回退到 `process.cwd()`。
pub fn cwd() -> String {
    std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default()
}
