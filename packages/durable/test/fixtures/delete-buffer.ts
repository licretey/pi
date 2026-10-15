// 在测量模块图之前预加载，使模块看到类似浏览器的全局环境，而不是 Node 的 Buffer。
Reflect.deleteProperty(globalThis, "Buffer");
