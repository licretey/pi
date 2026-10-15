//! pi-env：轻量守护进程，通过标准输入/输出为 Pi Durable 宿主提供本机执行环境
//!（见 docs/protocol.md）。通常通过 `ssh` 启动 `pi-env serve --token <hex>`。

mod decode;
mod errors;
mod exec;
mod frame;
mod fs;
mod output;
mod scan;
mod sys;
mod watch;
mod window;

use errors::Failure;
use exec::Control;
use frame::{CANCEL, ERROR, Frame, PING, REQUEST, RESULT};
use output::Output;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs::{File, ReadDir};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROTOCOL: u64 = 1;
/// 此守护进程随附的 npm 包版本（由 build.rs 提供）。
const VERSION: &str = env!("PI_ENV_VERSION");
const PING_INTERVAL: Duration = Duration::from_secs(5);
const SILENCE_LIMIT_MS: u64 = 30_000;
const SCAN_CHUNK: usize = 64 * 1024;
/// 文件操作使用的线程数；每条命令都在独立线程中运行。
const WORKERS: usize = 16;
/// 每个连接允许打开的句柄数；超出后打开操作会返回 `EMFILE`。
const MAX_HANDLES: usize = 4096;
/// 负载较大的响应会排在命令输出之后，而不会优先发送。
const CONTROL_PAYLOAD: usize = 64 * 1024;

struct FileHandle {
    file: File,
    path: String,
    /// 分块写入失败会使写入句柄失效，避免后续数据块之间出现缺口。
    failed: AtomicBool,
    /// 即使客户端同时发送多个数据块，服务端仍按到达顺序逐个写入。
    serial: Mutex<Serial>,
}

#[derive(Default)]
struct Serial {
    jobs: VecDeque<Job>,
    running: bool,
}

struct DirHandle {
    entries: ReadDir,
    path: String,
}

enum Handle {
    File(Arc<FileHandle>),
    Dir(Arc<Mutex<DirHandle>>),
}

type Job = Box<dyn FnOnce() + Send>;

struct Server {
    output: Arc<Output>,
    tmpdir: String,
    handles: Mutex<HashMap<u64, Handle>>,
    next_handle: AtomicU64,
    controls: Mutex<HashMap<u32, Arc<Control>>>,
    groups: exec::Groups,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn field<'a>(json: &'a Value, key: &str) -> Result<&'a str, Failure> {
    json[key]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing field {key}")))
}

fn number(json: &Value, key: &str) -> Result<u64, Failure> {
    json[key]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing or invalid field {key}")))
}

fn flag(json: &Value, key: &str) -> bool {
    json[key].as_bool().unwrap_or(false)
}

impl Server {
    fn file(&self, json: &Value) -> Result<Arc<FileHandle>, Failure> {
        match self.handles.lock().unwrap().get(&number(json, "handle")?) {
            Some(Handle::File(file)) => Ok(file.clone()),
            Some(Handle::Dir(_)) => Err(Failure::new("EBADF", "not a file handle")),
            None => Err(Failure::new("EBADF", "unknown handle")),
        }
    }

    fn insert(&self, handle: Handle) -> Result<u64, Failure> {
        let mut handles = self.handles.lock().unwrap();
        if handles.len() >= MAX_HANDLES {
            return Err(Failure::new("EMFILE", "EMFILE: too many open files"));
        }
        let id = self.next_handle.fetch_add(1, Ordering::Relaxed);
        handles.insert(id, handle);
        Ok(id)
    }

    fn insert_file(&self, file: File, path: &str) -> Result<u64, Failure> {
        self.insert(Handle::File(Arc::new(FileHandle {
            file,
            path: path.to_string(),
            failed: AtomicBool::new(false),
            serial: Mutex::new(Serial::default()),
        })))
    }

    fn dispatch(
        &self,
        id: u32,
        json: &Value,
        payload: Vec<u8>,
        control: &Control,
    ) -> Result<(Value, Vec<u8>), Failure> {
        if json.is_null() {
            return Err(Failure::new("EINVAL", "invalid JSON"));
        }
        let op = json["op"].as_str().unwrap_or_default();
        let plain = |value: Result<Value, Failure>| value.map(|value| (value, Vec::new()));
        match op {
            "hello" => plain(Ok(json!({
                "protocol": PROTOCOL,
                "version": VERSION,
                "os": env::consts::OS,
                "arch": env::consts::ARCH,
                "home": sys::home(),
                "separator": sys::PATH_SEPARATOR,
                "tmpdir": self.tmpdir,
                "cwd": sys::cwd(),
                "driveCwds": sys::drive_cwds(),
                "pid": std::process::id(),
            }))),
            "lstat" => plain(fs::lstat(field(json, "path")?)),
            "realpath" => plain(fs::realpath(field(json, "path")?)),
            "write" => {
                let path = field(json, "path")?;
                let parents = json["parents"].as_bool().unwrap_or(true);
                let file = fs::write(path, flag(json, "append"), parents, &payload)?;
                if !flag(json, "keep") {
                    return plain(Ok(json!({})));
                }
                plain(Ok(json!({ "handle": self.insert_file(file, path)? })))
            }
            "writeChunk" => {
                let handle = self.file(json)?;
                if handle.failed.load(Ordering::SeqCst) {
                    return Err(Failure::new("EBADF", "an earlier write failed"));
                }
                (&handle.file).write_all(&payload).map_err(|error| {
                    handle.failed.store(true, Ordering::SeqCst);
                    Failure::io(&error, "write", &handle.path)
                })?;
                plain(Ok(json!({})))
            }
            "truncate" => plain(fs::truncate(field(json, "path")?, number(json, "size")?)),
            "fsync" => plain(fs::fsync(field(json, "path")?)),
            "rename" => plain(fs::rename(field(json, "path")?, field(json, "to")?)),
            "mkdir" => plain(fs::mkdir(field(json, "path")?, flag(json, "recursive"))),
            "rm" => plain(fs::rm(
                field(json, "path")?,
                flag(json, "recursive"),
                flag(json, "force"),
            )),
            "mkdtemp" => plain(fs::mkdtemp(field(json, "path")?)),
            "open" => {
                let path = field(json, "path")?;
                if json["mode"].as_str() == Some("read") {
                    // Node 的 `open(path, "r")`：允许打开任意类型的文件，操作会阻塞；读取时可判断文件类型。
                    let file = sys::open(path, sys::OpenMode::Read)
                        .map_err(|error| Failure::io(&error, "open", path))?;
                    let stat = match file.metadata() {
                        Ok(metadata) => json!({ "stat": fs::info(path, &metadata) }),
                        Err(error) => {
                            json!({ "statError": Failure::io(&error, "fstat", path).to_json() })
                        }
                    };
                    let mut result = stat;
                    result["handle"] = json!(self.insert_file(file, path)?);
                    return plain(Ok(result));
                }
                let (file, info) = fs::open_reader(path, flag(json, "noFollow"))?;
                plain(Ok(
                    json!({ "handle": self.insert_file(file, path)?, "info": info }),
                ))
            }
            "pread" => {
                let handle = self.file(json)?;
                let length = (number(json, "length")? as usize).min(frame::MAX_PAYLOAD);
                let bytes = match json["offset"].as_u64() {
                    Some(offset) => fs::pread(&handle.file, &handle.path, offset, length)?,
                    None => fs::read(&handle.file, &handle.path, length)?,
                };
                Ok((json!({}), bytes))
            }
            "fstat" => {
                let handle = self.file(json)?;
                let metadata = handle
                    .file
                    .metadata()
                    .map_err(|error| Failure::io(&error, "fstat", &handle.path))?;
                plain(Ok(fs::info(&handle.path, &metadata)))
            }
            "scanLines" => {
                let handle = self.file(json)?;
                plain(scan_lines(&handle.file, &handle.path, json, control))
            }
            "opendir" => {
                let path = field(json, "path")?;
                let entries =
                    sys::read_dir(path).map_err(|error| Failure::io(&error, "opendir", path))?;
                let handle = self.insert(Handle::Dir(Arc::new(Mutex::new(DirHandle {
                    entries,
                    path: path.to_string(),
                }))))?;
                plain(Ok(json!({ "handle": handle })))
            }
            "readdir" => plain(self.read_dir(json)),
            "close" => {
                self.handles
                    .lock()
                    .unwrap()
                    .remove(&number(json, "handle")?);
                plain(Ok(json!({})))
            }
            "exec" => plain(exec::run(
                id,
                exec::ExecRequest::from_json(json)?,
                &self.tmpdir,
                &self.output,
                control,
                &self.groups,
            )),
            "watch" => plain(watch::run(id, json, &self.output, control)),
            _ => Err(Failure::new("EINVAL", format!("unknown operation {op}"))),
        }
    }

    fn read_dir(&self, json: &Value) -> Result<Value, Failure> {
        let max = number(json, "max")?.max(1) as usize;
        // 只锁定当前目录，避免缓慢的目录枚举阻塞其他请求。
        let dir = match self.handles.lock().unwrap().get(&number(json, "handle")?) {
            Some(Handle::Dir(dir)) => dir.clone(),
            _ => return Err(Failure::new("EBADF", "not a directory handle")),
        };
        let mut dir = dir.lock().unwrap();
        let mut entries = Vec::new();
        let mut done = false;
        while entries.len() < max {
            match dir.entries.next() {
                None => {
                    done = true;
                    break;
                }
                Some(Err(error)) => return Err(Failure::io(&error, "readdir", &dir.path)),
                Some(Ok(entry)) => entries.push(fs::dir_entry(&dir.path, &entry.file_name())),
            }
        }
        Ok(json!({ "entries": entries, "done": done }))
    }
}

fn scan_lines(file: &File, path: &str, json: &Value, control: &Control) -> Result<Value, Failure> {
    let start_line = number(json, "startLine")?;
    let end_line = json["endLine"].as_u64();
    if end_line.is_some_and(|end| end <= start_line) {
        return Err(Failure::new("EINVAL", "Invalid line range"));
    }
    let mut scanner = scan::LineScanner::new(start_line, end_line);
    let mut buffer = vec![0u8; SCAN_CHUNK];
    let mut position = 0u64;
    loop {
        if control.aborted.load(Ordering::SeqCst) {
            return Err(Failure::new("aborted", "aborted"));
        }
        let read = sys::read_at(file, &mut buffer, position)
            .map_err(|error| Failure::io(&error, "read", path))?;
        if read == 0 {
            return Ok(scanner.finish());
        }
        scanner.push(&buffer[..read]);
        position += read as u64;
    }
}

fn kill_all(groups: &exec::Groups) {
    for pid in groups.lock().unwrap().iter() {
        exec::kill_group(*pid);
    }
}

/// 记录最近一次收到字节时间的标准输入流，以便缓慢到达的大帧也被视为活跃客户端。
struct Seen<R> {
    inner: R,
    last_seen: Arc<AtomicU64>,
}

impl<R: Read> Read for Seen<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        if read > 0 {
            self.last_seen.store(now_ms(), Ordering::Relaxed);
        }
        Ok(read)
    }
}

fn start_workers() -> Sender<Job> {
    let (jobs, queue) = mpsc::channel::<Job>();
    let queue = Arc::new(Mutex::new(queue));
    for _ in 0..WORKERS {
        let queue: Arc<Mutex<Receiver<Job>>> = queue.clone();
        thread::spawn(move || {
            loop {
                let job = queue.lock().unwrap().recv();
                match job {
                    Ok(job) => job(),
                    Err(_) => return,
                }
            }
        });
    }
    jobs
}

fn respond(server: &Server, id: u32, request: Frame, control: Arc<Control>) {
    let is_exec = request.json["op"].as_str() == Some("exec");
    let reply = match server.dispatch(id, &request.json, request.payload, &control) {
        Ok((json, payload)) => Frame::with_payload(RESULT, id, json, payload),
        Err(failure) => Frame::new(ERROR, id, failure.to_json()),
    };
    server.controls.lock().unwrap().remove(&id);
    // 命令结果排在其输出之后；大负载不会阻塞 ping 和较小的响应。
    if is_exec || reply.payload.len() > CONTROL_PAYLOAD {
        server.output.bulk(reply, None);
    } else {
        server.output.control(reply);
    }
}

/// 将 `job` 排在该句柄先前的数据块写入之后；由一个线程池任务依次处理队列。
fn run_in_order(jobs: &Sender<Job>, handle: Arc<FileHandle>, job: Job) {
    let mut serial = handle.serial.lock().unwrap();
    serial.jobs.push_back(job);
    if serial.running {
        return;
    }
    serial.running = true;
    drop(serial);
    let _ = jobs.send(Box::new(move || {
        loop {
            let next = {
                let mut serial = handle.serial.lock().unwrap();
                let next = serial.jobs.pop_front();
                if next.is_none() {
                    serial.running = false;
                }
                next
            };
            match next {
                Some(job) => job(),
                None => return,
            }
        }
    }));
}

fn serve_frames(server: &Arc<Server>, input: &mut impl Read) -> io::Result<()> {
    let jobs = start_workers();
    while let Some(request) = frame::read_frame(input)? {
        match request.kind {
            REQUEST => {
                let id = request.id;
                // 在请求运行前完成注册，避免紧随其后的取消请求丢失。
                let control = Arc::new(Control::default());
                server.controls.lock().unwrap().insert(id, control.clone());
                // 命令和监视器可能长期运行，因此各自使用独立线程（监视器会递归遍历目录树）。
                if matches!(request.json["op"].as_str(), Some("exec" | "watch")) {
                    let worker = server.clone();
                    let spawned = thread::Builder::new()
                        .stack_size(16 * 1024 * 1024)
                        .spawn(move || respond(&worker, id, request, control));
                    if let Err(error) = spawned {
                        server.controls.lock().unwrap().remove(&id);
                        let failure = Failure::new("spawn_error", error.to_string());
                        server
                            .output
                            .bulk(Frame::new(ERROR, id, failure.to_json()), None);
                    }
                } else {
                    let worker = server.clone();
                    let serial = match request.json["op"].as_str() {
                        Some("writeChunk") => server.file(&request.json).ok(),
                        _ => None,
                    };
                    let job: Job = Box::new(move || respond(&worker, id, request, control));
                    match serial {
                        Some(handle) => run_in_order(&jobs, handle, job),
                        None => {
                            let _ = jobs.send(job);
                        }
                    }
                }
            }
            CANCEL => {
                let control = server.controls.lock().unwrap().get(&request.id).cloned();
                if let Some(control) = control {
                    control.cancel(request.json["mode"].as_str() == Some("kill"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn serve(token: &str) -> io::Result<()> {
    {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "PI-ENV {token}")?;
        stdout.flush()?;
    }
    let output = Arc::new(Output::default());
    let writer = {
        let output = output.clone();
        thread::spawn(move || {
            output.run(&mut BufWriter::with_capacity(1 << 20, io::stdout().lock()))
        })
    };
    let server = Arc::new(Server {
        output: output.clone(),
        tmpdir: sys::tmpdir(),
        handles: Mutex::new(HashMap::new()),
        next_handle: AtomicU64::new(1),
        controls: Mutex::new(HashMap::new()),
        groups: Arc::new(Mutex::new(Default::default())),
    });
    let last_seen = Arc::new(AtomicU64::new(now_ms()));
    {
        let output = output.clone();
        let last_seen = last_seen.clone();
        let groups = server.groups.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(PING_INTERVAL);
                output.control(Frame::new(PING, 0, json!({})));
                // 客户端失去响应（例如手机断网）后，不应留下仍在运行的任务。
                if now_ms().saturating_sub(last_seen.load(Ordering::Relaxed)) > SILENCE_LIMIT_MS {
                    kill_all(&groups);
                    std::process::exit(0);
                }
            }
        });
    }
    let mut input = BufReader::with_capacity(
        1 << 20,
        Seen {
            inner: io::stdin().lock(),
            last_seen,
        },
    );
    let result = serve_frames(&server, &mut input);
    // 无论输入因何结束，客户端都已断开：停止它启动的所有任务。
    kill_all(&server.groups);
    output.close();
    let _ = writer.join();
    result
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            let token = args
                .iter()
                .position(|arg| arg == "--token")
                .and_then(|index| args.get(index + 1));
            let Some(token) = token else {
                eprintln!("usage: pi-env serve --token <hex>");
                std::process::exit(2);
            };
            if let Err(error) = serve(token) {
                eprintln!("pi-env: {error}");
                std::process::exit(1);
            }
            // 请求线程可能仍在阻塞（例如等待打开 FIFO），但已没有客户端接收其响应。
            std::process::exit(0);
        }
        Some("--version") => println!("pi-env {VERSION}"),
        _ => {
            eprintln!("usage: pi-env serve --token <hex>");
            std::process::exit(2);
        }
    }
}
