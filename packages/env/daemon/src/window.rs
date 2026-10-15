//! Durable 的输出窗口（`ShellExecOptions.window`、`ShellOutputInfo.skipped`）：暂存并合并尚未交付的命令输出；
//! 若后续文本超出窗口限制（按字节或行数计算），它就不可能出现在调用方的尾部内容中，因此用计数替代。
//! 输出交付遵循调用方的提交节奏；前一帧尚未发送时会等待。

use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct Window {
    pub max_bytes: usize,
    pub max_lines: usize,
    pub min_interval: Duration,
    pub bytes_per_second: f64,
}

impl Window {
    pub fn from_json(json: &Value) -> Option<Window> {
        let object = json.as_object()?;
        Some(Window {
            max_bytes: object.get("maxBytes")?.as_u64()? as usize,
            max_lines: object.get("maxLines")?.as_u64()? as usize,
            min_interval: Duration::from_secs_f64(
                object.get("minIntervalMs")?.as_f64()?.max(0.0) / 1000.0,
            ),
            bytes_per_second: object.get("bytesPerSecond")?.as_f64()?.max(1.0),
        })
    }
}

#[derive(Default)]
struct Skipped {
    bytes: u64,
    newlines: u64,
    ends_with_newline: bool,
}

    /// 一条输出事件：对应的流、文本，以及紧邻它之前被省略的输出。
pub struct Event {
    pub stream: &'static str,
    pub text: String,
    pub skipped: Option<Value>,
}

pub struct Pending {
    window: Window,
    /// 尚未交付的文本，按流和到达顺序排列。
    segments: Vec<(&'static str, String)>,
    bytes: usize,
    newlines: usize,
    skipped: Option<Skipped>,
    next_send: Instant,
}

fn newline_count(text: &str) -> usize {
    text.bytes().filter(|byte| *byte == b'\n').count()
}

impl Pending {
    pub fn new(window: Window) -> Pending {
        Pending {
            window,
            segments: Vec::new(),
            bytes: 0,
            newlines: 0,
            skipped: None,
            next_send: Instant::now(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// 下一次允许交付的时间。
    pub fn next_send(&self) -> Instant {
        self.next_send
    }

    pub fn push(&mut self, stream: &'static str, text: String) {
        if text.is_empty() {
            return;
        }
        self.bytes += text.len();
        self.newlines += newline_count(&text);
        match self.segments.last_mut() {
            Some((last, existing)) if *last == stream => existing.push_str(&text),
            _ => self.segments.push((stream, text)),
        }
        // 修剪需要遍历暂存文本；累积到数个窗口大小后再执行。
        if self.bytes > 4 * (self.window.max_bytes + 1)
            || self.newlines > 4 * (self.window.max_lines + 1)
        {
            self.trim();
        }
    }

    /// 判断截断后的文本是否仍能证明被截掉的内容位于窗口之外。
    fn proves(&self, bytes: usize, newlines: usize) -> bool {
        bytes > self.window.max_bytes || newlines > self.window.max_lines
    }

    /// 找出最长的前缀，使剩余文本仍能证明其被排除在窗口外，并用计数替换该前缀。
    fn trim(&mut self) {
        let mut removed = String::new();
        // 优先处理完整片段。
        while self.segments.len() > 1 {
            let (bytes, newlines) = {
                let first = &self.segments[0].1;
                (first.len(), newline_count(first))
            };
            if !self.proves(self.bytes - bytes, self.newlines - newlines) {
                break;
            }
            let (_, text) = self.segments.remove(0);
            self.bytes -= bytes;
            self.newlines -= newlines;
            removed.push_str(&text);
        }
        // 然后在字符边界处截取第一个剩余片段的前缀。
        let rest_bytes = self.bytes - self.segments[0].1.len();
        let rest_newlines = self.newlines - newline_count(&self.segments[0].1);
        let first = &self.segments[0].1;
        let mut cut = 0;
        // 按字节数计算：整体保留超过 `max_bytes` 的部分。
        let keep_bytes = (self.window.max_bytes + 1).saturating_sub(rest_bytes);
        if first.len() > keep_bytes {
            let mut index = first.len() - keep_bytes;
            while index > 0 && !first.is_char_boundary(index) {
                index -= 1;
            }
            cut = cut.max(index);
        }
        // 按行数计算：整体保留超过 `max_lines` 个换行符的部分，从此片段中的换行符开始。
        let keep_newlines = (self.window.max_lines + 1).saturating_sub(rest_newlines);
        if keep_newlines > 0 {
            let positions: Vec<usize> = first
                .bytes()
                .enumerate()
                .filter(|(_, byte)| *byte == b'\n')
                .map(|(index, _)| index)
                .collect();
            if positions.len() >= keep_newlines {
                cut = cut.max(positions[positions.len() - keep_newlines]);
            }
        } else {
            cut = first.len();
        }
        if cut > 0 {
            let first = &mut self.segments[0].1;
            let prefix: String = first.drain(..cut).collect();
            self.bytes -= prefix.len();
            self.newlines -= newline_count(&prefix);
            removed.push_str(&prefix);
            if first.is_empty() {
                self.segments.remove(0);
            }
        }
        if !removed.is_empty() {
            let skipped = self.skipped.get_or_insert_with(Skipped::default);
            skipped.bytes += removed.len() as u64;
            skipped.newlines += newline_count(&removed) as u64;
            skipped.ends_with_newline = removed.ends_with('\n');
        }
    }

    /// 交付所有暂存内容：若有跳过内容，则用一条事件携带跳过信息及其后的所有文本；否则每个片段各用一条事件。
    pub fn take(&mut self) -> Vec<Event> {
        let segments = std::mem::take(&mut self.segments);
        let delivered = self.bytes;
        self.bytes = 0;
        self.newlines = 0;
        // 调用方每次采样最多写入一个窗口大小的数据，并根据实际写入量控制节奏。
        let pace = Duration::from_secs_f64(
            delivered.min(self.window.max_bytes) as f64 / self.window.bytes_per_second,
        );
        self.next_send = Instant::now() + self.window.min_interval.max(pace);
        match self.skipped.take() {
            Some(skipped) => {
                let stream = segments
                    .last()
                    .map(|(stream, _)| *stream)
                    .unwrap_or("stdout");
                let text: String = segments.into_iter().map(|(_, text)| text).collect();
                vec![Event {
                    stream,
                    text,
                    skipped: Some(json!({
                        "bytes": skipped.bytes,
                        "newlines": skipped.newlines,
                        "endsWithNewline": skipped.ends_with_newline,
                    })),
                }]
            }
            None => segments
                .into_iter()
                .map(|(stream, text)| Event {
                    stream,
                    text,
                    skipped: None,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(max_bytes: usize, max_lines: usize) -> Window {
        Window {
            max_bytes,
            max_lines,
            min_interval: Duration::ZERO,
            bytes_per_second: 1e12,
        }
    }

    /// 已交付或跳过的字节数与换行数，以及最后一次跳过后的文本。
    fn total(events: &[Event]) -> (u64, u64, String) {
        let mut bytes = 0;
        let mut newlines = 0;
        let mut after = String::new();
        for event in events {
            if let Some(skipped) = &event.skipped {
                bytes += skipped["bytes"].as_u64().unwrap();
                newlines += skipped["newlines"].as_u64().unwrap();
                after.clear();
            }
            bytes += event.text.len() as u64;
            newlines += newline_count(&event.text) as u64;
            after.push_str(&event.text);
        }
        (bytes, newlines, after)
    }

    #[test]
    fn counts_everything_and_keeps_more_than_the_window_after_a_skip() {
        let mut pending = Pending::new(window(10, 2));
        let mut full = String::new();
        let mut events = Vec::new();
        for index in 0..500 {
            let text = format!("line {index} é😀\n");
            full.push_str(&text);
            pending.push(if index % 7 == 0 { "stderr" } else { "stdout" }, text);
            if index % 50 == 49 {
                events.extend(pending.take());
            }
        }
        events.extend(pending.take());
        let (bytes, newlines, after) = total(&events);
        assert_eq!(bytes, full.len() as u64);
        assert_eq!(newlines, newline_count(&full) as u64);
        assert!(full.ends_with(&after));
        assert!(after.len() > 10 || newline_count(&after) > 2);
        assert!(events.iter().any(|event| event.skipped.is_some()));
    }

    #[test]
    fn delivers_streams_apart_without_skips() {
        let mut pending = Pending::new(window(1000, 1000));
        pending.push("stdout", "a".into());
        pending.push("stderr", "b".into());
        pending.push("stdout", "c".into());
        let events = pending.take();
        let streams: Vec<_> = events.iter().map(|event| event.stream).collect();
        assert_eq!(streams, ["stdout", "stderr", "stdout"]);
    }
}
