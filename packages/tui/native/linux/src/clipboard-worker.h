#include <pthread.h>
#include <time.h>
#include "../../clipboard.h"

static void read_clipboard(clipboard_job* job);
static pthread_mutex_t worker_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t worker_once = PTHREAD_ONCE_INIT;
static pthread_cond_t worker_changed;
static bool worker_ready, worker_busy, worker_waiting, worker_finished;
static clipboard_job worker_result;
static int (*signal_worker)(pthread_cond_t*);
static int (*wait_for_worker)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*);

static void initialize_worker_condition(void) {
// 否则，未指定版本的 ELF 导入会在 glibc x64 上绑定到已废弃的条件变量。
    int (*initialize)(pthread_cond_t*, const pthread_condattr_t*) = node_symbol("pthread_cond_init");
    signal_worker = node_symbol("pthread_cond_signal");
    wait_for_worker = node_symbol("pthread_cond_timedwait");
    if (!initialize || !signal_worker || !wait_for_worker) return;
    pthread_condattr_t attributes;
    if (pthread_condattr_init(&attributes) != 0) return;
    worker_ready = pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) == 0 &&
        initialize(&worker_changed, &attributes) == 0;
    pthread_condattr_destroy(&attributes);
}

static void* read_on_private_thread(void* unused) {
    (void)unused;
    read_clipboard(&worker_result);
    pthread_mutex_lock(&worker_mutex);
    worker_finished = true;
    if (!worker_waiting) {
        free(worker_result.data); // 调用方已超时；丢弃迟到的结果。
        worker_busy = false;
    }
    signal_worker(&worker_changed);
    pthread_mutex_unlock(&worker_mutex);
    return 0;
}

static void clipboard_execute(clipboard_job* job) {
    pthread_once(&worker_once, initialize_worker_condition);
    if (!worker_ready) return;
    pthread_mutex_lock(&worker_mutex);
    if (!worker_busy) {
        worker_busy = worker_waiting = true;
        worker_finished = false;
        worker_result = (clipboard_job){.operation = job->operation};
        struct timespec deadline;
        clock_gettime(CLOCK_MONOTONIC, &deadline);
            deadline.tv_sec += 3; // 留出 3 秒，让两秒的传输截止时间先报告自身错误。
        pthread_t thread;
        if (pthread_create(&thread, 0, read_on_private_thread, 0) == 0) {
            pthread_detach(thread);
            // 只有这段有时限的等待会占用 libuv。其他调用方会直接收到不可用结果。
            while (!worker_finished && wait_for_worker(&worker_changed, &worker_mutex, &deadline) == 0) {}
            if (worker_finished) {
                job->data = worker_result.data;
                job->length = worker_result.length;
                job->format = worker_result.format;
                job->error = worker_result.error;
                worker_busy = false;
            }
        } else {
            worker_busy = false;
        }
        worker_waiting = false;
    }
    pthread_mutex_unlock(&worker_mutex);
}
