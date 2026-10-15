#include <xcb/xcb.h>
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// 仅跟踪剪贴板实现自身的内存分配，不跟踪 libxcb 的分配。
// 与 RSS 测量相比，这能让部分传输时的内存泄漏回归测试具有确定性。
static void* allocations[64];
static size_t sizes[64];
static size_t allocated_bytes;
static size_t peak_bytes;

static void* tracked_realloc(void* pointer, size_t size) {
    size_t index = 0;
    while (index < 64 && allocations[index] != pointer) index++;
    assert(index < 64);
    void* result = realloc(pointer, size);
    if (result) {
        allocated_bytes = allocated_bytes - sizes[index] + size;
        sizes[index] = size;
        allocations[index] = result;
        if (allocated_bytes > peak_bytes) peak_bytes = allocated_bytes;
    }
    return result;
}

static void tracked_free(void* pointer) {
    for (size_t index = 0; pointer && index < 64; index++) {
        if (allocations[index] == pointer) {
            allocated_bytes -= sizes[index];
            sizes[index] = 0;
            allocations[index] = 0;
            break;
        }
    }
    free(pointer);
}

#define realloc tracked_realloc
#define free tracked_free
#include "../../native/linux/src/linux-platform-x11.c"
#undef realloc
#undef free

int main(int argc, char** argv) {
    if (argc != 2) return 1;
    if (strcmp(argv[1], "metadata") == 0) {
        xcb_atom_t atom = XCB_ATOM_STRING;
        property_data chunk = {
            .data = (unsigned char*)&atom, .length = sizeof(atom),
            .items = 1, .format = 32, .type = XCB_ATOM_ATOM,
        };
        property_data result = {0};
        assert(append_property(&result, &chunk));
        assert(append_property(&result, &chunk));
        assert(result.length == 2 * sizeof(atom) && result.items == 2);

        chunk.format = 8;
        chunk.items = sizeof(atom);
        assert(!append_property(&result, &chunk));
        chunk.format = 32;
        chunk.items = 1;
        chunk.type = XCB_ATOM_STRING;
        assert(!append_property(&result, &chunk));
        chunk.type = XCB_ATOM_ATOM;
        chunk.length--;
        assert(!append_property(&result, &chunk));
        assert(result.length == 2 * sizeof(atom) && result.items == 2);

        // 结束数据块也必须与前面的元数据一致。
        chunk.length = chunk.items = 0;
        chunk.format = 8;
        assert(!append_property(&result, &chunk));
        chunk.format = 32;
        assert(append_property(&result, &chunk));
        tracked_free(result.data);
        assert(allocated_bytes == 0);
        puts("validated");
        return 0;
    }
    if (strcmp(argv[1], "text") == 0 || strcmp(argv[1], "image") == 0) {
        x11_clipboard clipboard;
        assert(open_clipboard(&clipboard));
        property_data result = {0};
        bool received = read_selection(&clipboard, strcmp(argv[1], "image") == 0, &result);
        close_clipboard(&clipboard);
        assert(!received);
        assert(!result.data && !result.length);
        assert(peak_bytes >= 8192); // 接收的数据块和累计数据都已分配内存。
        assert(allocated_bytes == 0);
        puts("clean");
        return 0;
    }

    x11_clipboard clipboard;
    assert(open_clipboard(&clipboard));
    xcb_connection_t* connection = clipboard.connection;
    xcb_atom_t text = intern_atom(&clipboard, "UTF8_STRING");
    xcb_atom_t image = intern_atom(&clipboard, "image/png");
    xcb_set_selection_owner(connection, clipboard.window, clipboard.clipboard, XCB_CURRENT_TIME);
    // 等待服务器处理完选择所有权后再报告就绪。
    assert(intern_atom(&clipboard, "READY") != XCB_NONE);
    puts("ready");
    fflush(stdout);

    xcb_window_t requestor = XCB_NONE;
    xcb_atom_t property = XCB_NONE;
    xcb_atom_t target = XCB_NONE;
    bool sent_chunk = false;
    xcb_generic_event_t* event;
    while ((event = xcb_wait_for_event(connection))) {
        uint8_t type = event->response_type & 0x7f;
        if (type == XCB_SELECTION_REQUEST) {
            xcb_selection_request_event_t* request = (xcb_selection_request_event_t*)event;
            puts("requested");
            fflush(stdout);
            if (strcmp(argv[1], "idle") == 0) {
                free(event);
                continue;
            }
            xcb_atom_t response_property = request->property;
            if (strcmp(argv[1], "direct-text") == 0) {
                if (request->target == text) {
                    const char value[] = "café 日本語";
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor,
                        request->property, text, 8, sizeof(value) - 1, value);
                } else {
                    response_property = XCB_NONE;
                }
            } else if (request->target == clipboard.targets) {
                xcb_atom_t targets[] = {text, image};
                xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor,
                    request->property, XCB_ATOM_ATOM, 32, 2, targets);
            } else {
                requestor = request->requestor;
                property = request->property;
                target = request->target;
                uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
                xcb_change_window_attributes(connection, requestor, XCB_CW_EVENT_MASK, &mask);
                uint32_t length = 8192;
                xcb_change_property(connection, XCB_PROP_MODE_REPLACE, requestor,
                    property, clipboard.incr, 32, 1, &length);
            }
            union {
                xcb_selection_notify_event_t selection;
                char bytes[32];
            } notification = { .selection = {
                .response_type = XCB_SELECTION_NOTIFY,
                .time = request->time,
                .requestor = request->requestor,
                .selection = request->selection,
                .target = request->target,
                .property = response_property,
            } };
            xcb_send_event(connection, false, request->requestor, XCB_EVENT_MASK_NO_EVENT, notification.bytes);
            xcb_flush(connection);
        } else if (type == XCB_PROPERTY_NOTIFY) {
            xcb_property_notify_event_t* notification = (xcb_property_notify_event_t*)event;
            if (notification->window == requestor && notification->atom == property &&
                notification->state == XCB_PROPERTY_DELETE) {
                if (!sent_chunk) {
                    unsigned char chunk[4096] = {0};
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, requestor, property, target, 8, sizeof(chunk), chunk);
                    sent_chunk = true;
                } else if (strcmp(argv[1], "invalid") == 0) {
                    // 已分配前面的数据后，再验证结束数据块并拒绝无效内容。
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, requestor, property, XCB_ATOM_ATOM, 32, 0, 0);
                } // 否则传输永远不会结束，读取端只能等待超时。
                xcb_flush(connection);
            }
        }
        free(event);
    }
    close_clipboard(&clipboard);
}
