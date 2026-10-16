/**
 * 跨 IPC 载荷净化：递归复制成纯对象 / 纯数组，只保留可结构化克隆的值类型。
 *
 * 结构化克隆无法克隆 Proxy，而 Vue 的 `ref` / `reactive` 返回的正是 Proxy，
 * 直接把它送过 IPC 会抛 `An object could not be cloned`，因此渲染进程数据过 IPC 前都要先经过这里。
 */

/**
 * @description 把可能含 Vue 响应式代理的值复制成可被结构化克隆的纯数据
 * @param value 任意待发送的值
 * @returns 与入参同类型的纯数据副本
 */
export function toPlainPayload<T>(value: T): T {
  return copy(value, new WeakMap()) as T
}

/**
 * @description 递归复制实现；`seen` 负责切断循环引用
 * @param value 待复制的值
 * @param seen 已复制对象的映射
 * @returns 复制结果
 */
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
