/**
 * doomgeneric 的 pi-doom 平台实现。
 *
 * 最小化实现：不提供声音，只处理帧缓冲区和输入。
 */

#include "doomgeneric.h"
#include "doomkeys.h"
#include <emscripten.h>
#include <stdint.h>

// 按键事件队列。
#define KEY_QUEUE_SIZE 256
static struct {
  int pressed;
  unsigned char key;
} key_queue[KEY_QUEUE_SIZE];
static int key_queue_read = 0;
static int key_queue_write = 0;

// 获取供 JavaScript 读取的帧缓冲区指针。
EMSCRIPTEN_KEEPALIVE
uint32_t *DG_GetFrameBuffer(void) { return DG_ScreenBuffer; }

// 获取帧缓冲区尺寸。
EMSCRIPTEN_KEEPALIVE
int DG_GetScreenWidth(void) { return DOOMGENERIC_RESX; }

EMSCRIPTEN_KEEPALIVE
int DG_GetScreenHeight(void) { return DOOMGENERIC_RESY; }

// 接收并加入来自 JavaScript 的按键事件。
EMSCRIPTEN_KEEPALIVE
void DG_PushKeyEvent(int pressed, unsigned char key) {
  int next_write = (key_queue_write + 1) % KEY_QUEUE_SIZE;
  if (next_write != key_queue_read) {
    key_queue[key_queue_write].pressed = pressed;
    key_queue[key_queue_write].key = key;
    key_queue_write = next_write;
  }
}

void DG_Init(void) {
  // 无需初始化。
}

void DG_DrawFrame(void) {
  // 当前帧存储在 DG_ScreenBuffer 中，JavaScript 通过 DG_GetFrameBuffer 读取。
}

void DG_SleepMs(uint32_t ms) {
  // 不执行操作，计时由 JavaScript 负责。
  (void)ms;
}

uint32_t DG_GetTicksMs(void) {
  return (uint32_t)emscripten_get_now();
}

int DG_GetKey(int *pressed, unsigned char *key) {
  if (key_queue_read != key_queue_write) {
    *pressed = key_queue[key_queue_read].pressed;
    *key = key_queue[key_queue_read].key;
    key_queue_read = (key_queue_read + 1) % KEY_QUEUE_SIZE;
    return 1;
  }
  return 0;
}

void DG_SetWindowTitle(const char *title) {
  (void)title;
}
