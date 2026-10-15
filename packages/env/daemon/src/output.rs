//! 标准输出的唯一写入者。控制帧（结果、错误、ping、监视事件）始终优先于大量命令输出，
//! 因此连接缓慢只会延迟输出，不会延迟取消结果或 ping。大量输出有大小上限：未设置输出窗口的命令，
//! 如果待发送数据过多，读取线程就会等待，效果类似管道已满时对命令施加反压。

use crate::frame::{self, Frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// 未设置输出窗口时，待发送的大量输出超过此字节数后命令输出将等待。
const BULK_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Queues {
    control: VecDeque<Frame>,
    bulk: VecDeque<(Frame, Option<Arc<AtomicUsize>>)>,
    bulk_bytes: usize,
    closed: bool,
}

#[derive(Default)]
pub struct Output {
    queues: Mutex<Queues>,
    /// 有帧入队或写入器停止时发出通知。
    queued: Condvar,
    /// 大量输出字节写入后发出通知。
    drained: Condvar,
}

impl Output {
    pub fn control(&self, frame: Frame) {
        let mut queues = self.queues.lock().unwrap();
        queues.control.push_back(frame);
        self.queued.notify_one();
    }

    /// 将大量输出加入队列；在帧写入前，`unsent` 会统计此发送方待写入的字节数。
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        let mut queues = self.queues.lock().unwrap();
        queues.bulk_bytes += frame.payload.len();
        if let Some(counter) = &unsent {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        queues.bulk.push_back((frame, unsent));
        self.queued.notify_one();
    }

    /// 待发送数据超过大量输出上限时等待，除非 `stop` 已设置。
    pub fn wait_for_room(&self, stop: &AtomicBool) {
        let mut queues = self.queues.lock().unwrap();
        while queues.bulk_bytes > BULK_LIMIT && !queues.closed && !stop.load(Ordering::SeqCst) {
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    pub fn close(&self) {
        let mut queues = self.queues.lock().unwrap();
        queues.closed = true;
        self.queued.notify_all();
        self.drained.notify_all();
    }

    /// 持续向 `writer` 写入帧，直到关闭或写入失败。
    pub fn run(&self, writer: &mut impl Write) {
        loop {
            let (frame, unsent) = {
                let mut queues = self.queues.lock().unwrap();
                loop {
                    if let Some(frame) = queues.control.pop_front() {
                        break (frame, None);
                    }
                    if let Some((frame, unsent)) = queues.bulk.pop_front() {
                        queues.bulk_bytes -= frame.payload.len();
                        break (frame, unsent);
                    }
                    if queues.closed {
                        return;
                    }
                    queues = self.queued.wait(queues).unwrap();
                }
            };
            let failed = frame::write_frame(writer, &frame).is_err();
            if let Some(counter) = unsent {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            self.drained.notify_all();
            if failed {
                self.close();
                return;
            }
        }
    }
}
