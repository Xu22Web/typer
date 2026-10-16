import { describe, expect, it, vi } from 'vitest'
import { ProcessLinesClient } from '@main/typing/drivers/powershellDriver'
import { ProtocolError } from '@main/typing/drivers/protocol'
import { createFakeSpawn } from '../../helpers/fakes'

/** request() 会先 await ensureRunning()，因此写入发生在下一个微任务，测试需要先冲刷一次。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function createClient(options: { requestTimeoutMs?: number; maxRestarts?: number } = {}): {
  client: ProcessLinesClient
  spawn: ReturnType<typeof createFakeSpawn>
  logs: string[]
} {
  const spawn = createFakeSpawn()
  const logs: string[] = []
  const client = new ProcessLinesClient({
    command: 'powershell.exe',
    args: ['-NoProfile', '-File', 'host.ps1'],
    spawn: spawn.fn,
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    maxRestarts: options.maxRestarts ?? 2,
    onLog: (_level, message) => logs.push(message)
  })
  return { client, spawn, logs }
}

describe('ProcessLinesClient 启动', () => {
  it('按给定命令与参数启动进程，并只启动一次', async () => {
    const { client, spawn } = createClient()
    await client.start()
    await client.start()

    expect(spawn.calls).toHaveLength(1)
    expect(spawn.calls[0]?.command).toBe('powershell.exe')
    expect(spawn.calls[0]?.args).toEqual(['-NoProfile', '-File', 'host.ps1'])
    expect(spawn.calls[0]?.options.windowsHide).toBe(true)
    expect(client.running).toBe(true)
    expect(client.pid).toBe(4242)
  })

  it('并发 start 只会启动一个进程', async () => {
    const { client, spawn } = createClient()
    await Promise.all([client.start(), client.start(), client.start()])
    expect(spawn.calls).toHaveLength(1)
  })
})

describe('ProcessLinesClient 请求响应', () => {
  it('写入 JSON 行并解析对应 id 的响应', async () => {
    const { client, spawn } = createClient()
    const pending = client.request<{ os: string }>('ping')
    await flush()

    const child = spawn.children[0]
    expect(child?.parsedRequests()).toEqual([{ id: 1, cmd: 'ping' }])

    child?.respondOk(1, { os: 'Windows' })
    await expect(pending).resolves.toEqual({ os: 'Windows' })
  })

  it('忽略无关 id 的响应，并给出警告', async () => {
    const { client, spawn, logs } = createClient()
    const pending = client.request('ping')
    await flush()
    const child = spawn.children[0]

    child?.respondOk(99, { ignored: true })
    child?.respondOk(1, { ok: true })

    await pending
    expect(logs.some((line) => line.includes('未知 id=99'))).toBe(true)
  })

  it('忽略无法解析的输出行，不影响后续请求', async () => {
    const { client, spawn, logs } = createClient()
    const pending = client.request('ping')
    await flush()
    const child = spawn.children[0]

    child?.emitStdout('这不是 JSON\n')
    child?.respondOk(1)

    await pending
    expect(logs.some((line) => line.includes('无法解析'))).toBe(true)
  })

  it('失败响应转成带错误码的 ProtocolError', async () => {
    const { client, spawn } = createClient()
    const pending = client.request('type')
    await flush()
    spawn.children[0]?.respondError(1, 'E_INJECT_FAILED', '被拦截')

    await expect(pending).rejects.toMatchObject({ code: 'E_INJECT_FAILED', message: '被拦截' })
  })

  it('分片到达的响应也能正确解析', async () => {
    const { client, spawn } = createClient()
    const pending = client.request('ping')
    await flush()
    const child = spawn.children[0]
    child?.emitStdout('{"id":1,"ok":tr')
    child?.emitStdout('ue,"data":{"x":2}}\n')
    await expect(pending).resolves.toEqual({ x: 2 })
  })

  it('按 id 并发请求不会串台', async () => {
    const { client, spawn } = createClient()
    const first = client.request<{ n: number }>('a')
    const second = client.request<{ n: number }>('b')
    await flush()
    const child = spawn.children[0]
    const requests = child?.parsedRequests() ?? []
    expect(requests).toHaveLength(2)

    // 按命令名（而不是调用顺序）取 id，验证响应与请求的对应关系
    const idA = Number(requests.find((request) => request.cmd === 'a')?.id)
    const idB = Number(requests.find((request) => request.cmd === 'b')?.id)
    expect(idA).not.toBe(idB)

    // 故意乱序响应
    child?.respondOk(idB, { n: 2 })
    child?.respondOk(idA, { n: 1 })

    await expect(first).resolves.toEqual({ n: 1 })
    await expect(second).resolves.toEqual({ n: 2 })
  })
})

describe('ProcessLinesClient 异常路径', () => {
  it('超时抛 E_TIMEOUT', async () => {
    vi.useFakeTimers()
    try {
      const { client } = createClient({ requestTimeoutMs: 500 })
      const pending = client.request('ping')
      const assertion = expect(pending).rejects.toMatchObject({ code: 'E_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(600)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('进程在响应前退出：挂起的请求抛 E_HOST_EXIT', async () => {
    const { client, spawn } = createClient()
    const pending = client.request('ping')
    await flush()

    const assertion = expect(pending).rejects.toMatchObject({ code: 'E_HOST_EXIT' })
    spawn.children[0]?.emitStderr('宿主崩了')
    spawn.children[0]?.exit(1, null)

    await assertion
    expect(client.running).toBe(false)
    expect(client.lastStderr).toContain('宿主崩了')
  })

  it('进程退出后再次请求会自动重启', async () => {
    const { client, spawn, logs } = createClient()
    const first = client.request('ping')
    await flush()
    spawn.children[0]?.respondOk(1)
    await first

    spawn.children[0]?.exit(0, null)

    const second = client.request('ping')
    await flush()
    expect(spawn.children).toHaveLength(2)
    spawn.children[1]?.respondOk(2)
    await second

    expect(client.restarts).toBe(1)
    expect(logs.some((line) => line.includes('正在重启'))).toBe(true)
  })

  it('连续崩溃超过上限后拒绝启动', async () => {
    const { client, spawn } = createClient({ maxRestarts: 1 })

    const first = client.request('ping')
    await flush()
    spawn.children[0]?.respondOk(1)
    await first

    spawn.children[0]?.exit(0, null)
    const second = client.request('ping')
    await flush()
    spawn.children[1]?.respondOk(2)
    await second

    spawn.children[1]?.exit(0, null)
    await expect(client.request('ping')).rejects.toMatchObject({ code: 'E_HOST_EXIT' })
  })

  it('spawn 抛错时请求失败但错误可读', async () => {
    const { client, spawn } = createClient()
    spawn.failNext = new Error('ENOENT powershell.exe')
    await expect(client.request('ping')).rejects.toThrow(/ENOENT/)
  })

  it('stderr 会被保留用于诊断', async () => {
    const { client, spawn } = createClient()
    await client.start()
    spawn.children[0]?.emitStderr('Add-Type 编译失败')
    expect(client.lastStderr).toContain('Add-Type')
  })
})

describe('ProcessLinesClient 关闭', () => {
  it('dispose 会发送 shutdown、关闭 stdin 并杀掉进程', async () => {
    const { client, spawn } = createClient()
    await client.start()
    await client.dispose()

    const child = spawn.children[0]
    expect(child?.parsedRequests().some((request) => request.cmd === 'shutdown')).toBe(true)
    expect(child?.stdinEnded).toBe(true)
    expect(child?.killed).toBe(true)
    expect(client.running).toBe(false)
  })

  it('dispose 后拒绝新请求，且重复 dispose 安全', async () => {
    const { client } = createClient()
    await client.start()
    await client.dispose()
    await client.dispose()

    await expect(client.request('ping')).rejects.toBeInstanceOf(ProtocolError)
  })

  it('dispose 会拒绝所有挂起请求', async () => {
    const { client } = createClient()
    const pending = client.request('ping')
    await flush()
    const assertion = expect(pending).rejects.toMatchObject({ code: 'E_HOST_EXIT' })
    await client.dispose()
    await assertion
  })
})
