/**
 * 跨 IPC 载荷净化。
 *
 * 背景：Electron 的 `ipcRenderer.invoke` 与 `contextBridge` 都用 V8 的结构化克隆
 * 序列化参数，而**结构化克隆无法克隆 Proxy**。渲染进程里的 Vue `ref` / `reactive`
 * 返回的正是 Proxy，直接把它交给 `window.api.*` 会抛出
 * `An object could not be cloned`，导致整个调用失败（设置保存就是这样被打断的）。
 *
 * 因此凡是把渲染进程的数据送过 IPC 的地方，都要先经过本函数：
 * 递归复制成纯对象 / 纯数组，只保留可克隆的值类型。
 */
export function toPlainPayload<T>(value: T): T {
  return copy(value, new WeakMap()) as T
}

function copy(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null) return null

  const type = typeof value
  if (type !== 'object') {
    // 函数无法被结构化克隆，丢成 undefined
    return type === 'function' ? undefined : value
  }

  // 这些类型本身可被结构化克隆，复制一份避免共享引用
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value

  const source = value as object
  const cached = seen.get(source)
  if (cached !== undefined) return cached

  if (Array.isArray(source)) {
    const result: unknown[] = []
    seen.set(source, result)
    for (const item of source) result.push(copy(item, seen))
    return result
  }

  if (source instanceof Map) {
    const result = new Map<unknown, unknown>()
    seen.set(source, result)
    for (const [key, item] of source) result.set(copy(key, seen), copy(item, seen))
    return result
  }

  if (source instanceof Set) {
    const result = new Set<unknown>()
    seen.set(source, result)
    for (const item of source) result.add(copy(item, seen))
    return result
  }

  // 纯对象 / Vue 响应式对象（Proxy）/ class 实例：只复制自有可枚举字段。
  // Vue 的内部标记都在非枚举的 Symbol 上，因此不会被带出来。
  const result: Record<string, unknown> = {}
  seen.set(source, result)
  for (const key of Object.keys(source)) {
    const copied = copy((source as Record<string, unknown>)[key], seen)
    if (copied !== undefined) result[key] = copied
  }
  return result
}
