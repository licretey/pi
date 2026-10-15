//! 按 Node 的格式报告错误：包含 `ENOENT` 等错误代码及诊断消息。

use serde_json::{Value, json};
use std::io;

/// 使用 Node 风格错误代码表示的失败；消息仅用于诊断。
#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    details: Option<Box<Details>>,
}

#[derive(Debug, Default)]
struct Details {
    syscall: Option<String>,
    path: Option<String>,
    /// 提供给客户端的额外字段，例如 `spillPath`。
    extra: Option<Value>,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Failure {
        Failure {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    fn details(&mut self) -> &mut Details {
        self.details.get_or_insert_with(Default::default)
    }

    /// 向错误 JSON 添加字段，例如 `spillPath`。
    pub fn extra(mut self, extra: Value) -> Failure {
        self.details().extra = Some(extra);
        self
    }

    /// `path` 上的 `syscall` I/O 错误，错误代码采用 libuv 的错误名称。
    pub fn io(error: &io::Error, syscall: &str, path: &str) -> Failure {
        Failure::io_between(error, syscall, path, None)
    }

    /// 双路径调用错误的 Node 消息格式：`CODE: description, syscall 'from' -> 'to'`。
    pub fn io_between(
        error: &io::Error,
        syscall: &str,
        path: &str,
        destination: Option<&str>,
    ) -> Failure {
        let code = crate::sys::error_name(error).to_string();
        let description = describe(&code).map(str::to_string).unwrap_or_else(|| {
            // libuv 错误表中没有此错误代码：使用操作系统消息，并去掉 Rust 添加的 " (os error N)"。
            let text = error.to_string();
            text.split(" (os error")
                .next()
                .unwrap_or(&text)
                .to_lowercase()
        });
        let target = match destination {
            Some(destination) => format!("'{path}' -> '{destination}'"),
            None => format!("'{path}'"),
        };
        let mut failure = Failure::new(&code, format!("{code}: {description}, {syscall} {target}"));
        failure.details().syscall = Some(syscall.to_string());
        failure.path(path)
    }

    pub fn path(mut self, path: &str) -> Failure {
        self.details().path = Some(path.to_string());
        self
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({ "code": self.code, "message": self.message });
        let Some(details) = &self.details else {
            return value;
        };
        if let Some(syscall) = &details.syscall {
            value["syscall"] = json!(syscall);
        }
        if let Some(path) = &details.path {
            value["path"] = json!(path);
        }
        if let Some(Value::Object(extra)) = &details.extra {
            for (key, field) in extra {
                value[key] = field.clone();
            }
        }
        value
    }
}

/// libuv 的 `uv_strerror` 错误文本，Node 在所有系统上都使用这些文本。
fn describe(code: &str) -> Option<&'static str> {
    Some(match code {
        "EACCES" => "permission denied",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "EEXIST" => "file already exists",
        "EFBIG" => "file too large",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENOENT" => "no such file or directory",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSUP" => "operation not supported on socket",
        "EPERM" => "operation not permitted",
        "EROFS" => "read-only file system",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        _ => return None,
    })
}
