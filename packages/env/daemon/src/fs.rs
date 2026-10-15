//! 当 Rust 标准库行为与 Node 不同时，按 Node 语义执行文件操作（见 docs/semantics.md）。

use crate::errors::Failure;
use crate::sys;
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::Path;

pub type Outcome<T> = Result<T, Failure>;

/// lstat 或 fstat 元数据，字段为 `{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }`。
pub fn info(path: &str, metadata: &Metadata) -> Value {
    let file_type = metadata.file_type();
    let kind = if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (mtime_sec, mtime_nsec) = sys::mtime(metadata);
    let (dev, ino) = sys::identity(metadata);
    json!({
        "name": name,
        "kind": kind,
        "size": metadata.len(),
        "mtimeSec": mtime_sec,
        "mtimeNsec": mtime_nsec,
        "dev": dev,
        "ino": ino,
    })
}

pub fn lstat(path: &str) -> Outcome<Value> {
    fs::symlink_metadata(path)
        .map(|metadata| info(path, &metadata))
        .map_err(|error| Failure::io(&error, "lstat", path))
}

pub fn realpath(path: &str) -> Outcome<Value> {
    sys::realpath(path)
        .map(|resolved| json!({ "path": resolved }))
        .map_err(|error| Failure::io(&error, "realpath", path))
}

/// Node 的递归 `mkdir` 语义：目录已存在时正常返回，文件已存在时返回 `EEXIST`，
/// 创建路径中的父级被文件阻挡时返回 `ENOTDIR`。
pub fn mkdir_recursive(path: &Path) -> io::Result<()> {
    let is_dir = |path: &Path| {
        fs::metadata(path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
    };
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if is_dir(path) {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            else {
                return Err(error);
            };
            match mkdir_recursive(parent) {
                Err(parent_error) if parent_error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(sys::synthetic("ENOTDIR"));
                }
                other => other?,
            }
            match fs::create_dir(path) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && is_dir(path) => {
                    Ok(())
                }
                other => other,
            }
        }
        Err(error) => Err(error),
    }
}

pub fn mkdir(path: &str, recursive: bool) -> Outcome<Value> {
    let result = if recursive {
        mkdir_recursive(Path::new(path))
    } else {
        fs::create_dir(path)
    };
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "mkdir", path))
}

/// `writeFile`/`appendFile`：像 Node 的递归 `mkdir` 一样创建缺失的父目录，然后写入数据。返回打开的文件，
/// 供后续数据块继续写入。
pub fn write(path: &str, append: bool, parents: bool, content: &[u8]) -> Outcome<File> {
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|_| parents)
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        mkdir_recursive(parent)
            .map_err(|error| Failure::io(&error, "mkdir", &parent.to_string_lossy()))?;
    }
    let mode = if append {
        sys::OpenMode::Append
    } else {
        sys::OpenMode::Write
    };
    let mut file = sys::open(path, mode).map_err(|error| Failure::io(&error, "open", path))?;
    file.write_all(content)
        .map_err(|error| Failure::io(&error, "write", path))?;
    Ok(file)
}

fn open_existing_for_write(path: &str) -> Outcome<File> {
    sys::open(path, sys::OpenMode::ReadWrite).map_err(|error| Failure::io(&error, "open", path))
}

pub fn truncate(path: &str, size: u64) -> Outcome<Value> {
    let file = open_existing_for_write(path)?;
    file.set_len(size)
        .map_err(|error| Failure::io(&error, "ftruncate", path))?;
    Ok(json!({}))
}

pub fn fsync(path: &str) -> Outcome<Value> {
    // POSIX 不允许以写入方式打开目录；先行检查，使 Windows 也返回相同结果。
    if fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(Failure::new(
            "EISDIR",
            format!("EISDIR: illegal operation on a directory, open '{path}'"),
        )
        .path(path));
    }
    let file = open_existing_for_write(path)?;
    file.sync_all()
        .map_err(|error| Failure::io(&error, "fsync", path))?;
    Ok(json!({}))
}

pub fn rename(from: &str, to: &str) -> Outcome<Value> {
    sys::rename(from, to)
        .map(|()| json!({}))
        .map_err(|error| Failure::io_between(&error, "rename", from, Some(to)))
}

/// Node 的 `fs.rm` 语义：路径不存在时除非设置 `force` 否则失败；删除目录但未设置 `recursive` 时返回 `ERR_FS_EISDIR`。
pub fn rm(path: &str, recursive: bool, force: bool) -> Outcome<Value> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(Failure::io(&error, "lstat", path)),
    };
    let result = if metadata.is_dir() {
        if !recursive {
            return Err(Failure::new(
                "ERR_FS_EISDIR",
                format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
            )
            .path(path));
        }
        fs::remove_dir_all(path)
    } else {
        sys::remove_file(path)
    };
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "rm", path))
}

/// 新建目录，名称由 `prefix` 和六个随机字符组成，与 libuv 的 `mkdtemp` 行为一致。
pub fn mkdtemp(prefix: &str) -> Outcome<Value> {
    sys::mkdtemp(prefix)
        .map(|path| json!({ "path": path }))
        .map_err(|error| Failure::io(&error, "mkdtemp", &format!("{prefix}XXXXXX")))
}

/// 打开普通文件以进行定位读取；目录返回 `EISDIR`，其他非普通文件返回 `NOT_REGULAR`，
/// 设置 `no_follow` 时，最终路径分量为符号链接则返回 `SYMLINK`。
pub fn open_reader(path: &str, no_follow: bool) -> Outcome<(File, Value)> {
    let file = sys::open_reader(path, no_follow)?;
    let metadata = file
        .metadata()
        .map_err(|error| Failure::io(&error, "fstat", path))?;
    if metadata.is_dir() {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    if !metadata.is_file() {
        return Err(Failure::new("NOT_REGULAR", "Not a regular file").path(path));
    }
    let info = info(path, &metadata);
    Ok((file, info))
}

/// 从 `offset` 开始读取最多 `length` 个字节；只有到达文件末尾时才可能少于该长度。
pub fn pread(file: &File, path: &str, offset: u64, length: usize) -> Outcome<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    let mut filled = 0;
    while filled < length {
        match sys::read_at(file, &mut buffer[filled..], offset + filled as u64) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// 从当前位置读取最多 `length` 个字节，只调用一次 `read`；与 Node 对大小未知的文件（FIFO、设备）执行
/// `readFile` 时的行为一致。
pub fn read(mut file: &File, path: &str, length: usize) -> Outcome<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    loop {
        match file.read(&mut buffer) {
            Ok(read) => {
                buffer.truncate(read);
                return Ok(buffer);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
}

/// Node 枚举到的单个目录项：名称按 UTF-8 解码（无效字节会被替换），并对目录与解码后名称拼接出的路径执行 lstat，
/// 因此名称包含无效 UTF-8 时会像 Node 一样返回 `ENOENT`。`raw` 保存该名称的原始字节，供 libuv 排序使用。
pub fn dir_entry(dir: &str, file_name: &OsStr) -> Value {
    let name = file_name.to_string_lossy().into_owned();
    let entry_path = Path::new(dir).join(&name).to_string_lossy().into_owned();
    let mut entry = match fs::symlink_metadata(&entry_path) {
        Ok(metadata) => json!({ "name": name, "info": info(&entry_path, &metadata) }),
        Err(error) => {
            json!({ "name": name, "error": Failure::io(&error, "lstat", &entry_path).to_json() })
        }
    };
    if let Some(raw) = sys::raw_name(file_name).filter(|raw| *raw != name.as_bytes()) {
        entry["raw"] = json!(raw);
    }
    entry
}
