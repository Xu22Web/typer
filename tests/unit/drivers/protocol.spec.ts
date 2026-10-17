import { describe, expect, it } from 'vitest'
import {
  assertInjectionResult,
  createLineDecoder,
  describeError,
  encodeHostItems,
  encodeRequest,
  ERROR_MESSAGES,
  escapeNonAscii,
  expectedEventCount,
  HOST_OP,
  isPlainAsciiText,
  MODIFIER_BITS,
  parseResponse,
  ProtocolError,
  toHostItems,
  toUnicodeHostItems
} from '@main/typing/drivers/protocol'
import type { KeystrokeAction } from '@main/typing/planner/types'

describe('escapeNonAscii', () => {
  it('把中文转成 \\uXXXX 转义，使传输内容保持纯 ASCII', () => {
    expect(escapeNonAscii('"中"')).toBe('"\\u4e2d"')
    expect(escapeNonAscii('你好')).toBe('\\u4f60\\u597d')
  })

  it('emoji 的代理对分别转义', () => {
    expect(escapeNonAscii('😀')).toBe('\\ud83d\\ude00')
  })

  it('ASCII 保持不变', () => {
    const ascii = '{"id":1,"cmd":"ping"}'
    expect(escapeNonAscii(ascii)).toBe(ascii)
  })

  it('转义结果里不残留任何非 ASCII 字节', () => {
    const value = escapeNonAscii(JSON.stringify({ title: '窗口标题 😀' }))
    expect(/[^\x20-\x7e]/.test(value)).toBe(false)
  })
})

describe('encodeRequest', () => {
  it('输出一行纯 ASCII + 换行', () => {
    const line = encodeRequest({ id: 7, cmd: 'type', items: [{ t: 'unicode', cu: 0x4e2d }] })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n').filter((part) => part.length > 0)).toHaveLength(1)
    const payload = line.replace(/\n$/, '')
    expect(/[^\x20-\x7e]/.test(payload)).toBe(false)
    expect(JSON.parse(payload)).toEqual({
      id: 7,
      cmd: 'type',
      items: [{ t: 'unicode', cu: 0x4e2d }]
    })
  })
})

describe('createLineDecoder', () => {
  it('把分片补齐成完整行', () => {
    const decode = createLineDecoder()
    expect(decode('{"id":1,')).toEqual([])
    expect(decode('"ok":true}\n')).toEqual(['{"id":1,"ok":true}'])
  })

  it('一次收到多行（粘包）会全部返回', () => {
    const decode = createLineDecoder()
    expect(decode('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('兼容 CRLF 与空行', () => {
    const decode = createLineDecoder()
    expect(decode('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('Buffer 输入按 UTF-8 解码', () => {
    const decode = createLineDecoder()
    expect(decode(Buffer.from('{"ok":true}\n', 'utf8'))).toEqual(['{"ok":true}'])
  })

  it('异常超长未结束行会被丢弃，避免内存无限增长', () => {
    const decode = createLineDecoder()
    decode('x'.repeat(1_000_001))
    expect(decode('{"a":1}\n')).toEqual(['{"a":1}'])
  })
})

describe('parseResponse', () => {
  it('解析合法响应', () => {
    expect(parseResponse('{"id":3,"ok":true,"data":{"n":1}}')).toEqual({
      id: 3,
      ok: true,
      data: { n: 1 }
    })
  })

  it('失败响应必须带 error.code', () => {
    expect(() => parseResponse('{"id":1,"ok":false}')).toThrow(ProtocolError)
    expect(
      parseResponse('{"id":1,"ok":false,"error":{"code":"E_X","message":"m"}}').error?.code
    ).toBe('E_X')
  })

  it('畸形 JSON / 缺少字段都会抛出 E_PARSE', () => {
    expect(() => parseResponse('not json')).toThrow(ProtocolError)
    expect(() => parseResponse('{"ok":true}')).toThrow(/缺少 id/)
    try {
      parseResponse('{')
    } catch (error) {
      expect((error as ProtocolError).code).toBe('E_PARSE')
    }
  })
})

describe('toHostItems', () => {
  it('把动作与延迟转成宿主指令（延迟保留 0.25ms 精度）', () => {
    const scheduled: Array<{ action: KeystrokeAction; delayMs: number }> = [
      { action: { kind: 'key', vk: 0x48, modifiers: ['shift'], char: 'H' }, delayMs: 30.4 },
      { action: { kind: 'unicode', codeUnit: 0x4e2d, char: '中' }, delayMs: 30.6 },
      { action: { kind: 'delay', ms: 500, reason: 'explicit' }, delayMs: 0 }
    ]
    expect(toHostItems(scheduled)).toEqual([
      { t: 'key', vk: 0x48, mods: ['shift'], delay: 30.5 },
      { t: 'unicode', cu: 0x4e2d, delay: 30.5 },
      { t: 'wait', ms: 500 }
    ])
  })

  it('亚毫秒延迟不会被取整成 1ms（极速档需要）', () => {
    expect(
      toHostItems([{ action: { kind: 'key', vk: 0x41, modifiers: [], char: 'a' }, delayMs: 0.25 }])
    ).toEqual([{ t: 'key', vk: 0x41, mods: [], delay: 0.25 }])
  })

  it('负数延迟被夹取到 0', () => {
    expect(
      toHostItems([{ action: { kind: 'key', vk: 0x41, modifiers: [], char: 'a' }, delayMs: -5 }])
    ).toEqual([{ t: 'key', vk: 0x41, mods: [], delay: 0 }])
  })
})

describe('帧模式快路径', () => {
  it('纯 ASCII 帧直接按码元编码，换行映射成 CR 且无延迟', () => {
    expect(toUnicodeHostItems('A\nB')).toEqual([
      { t: 'unicode', cu: 0x41, delay: 0 },
      { t: 'unicode', cu: 0x0d, delay: 0 },
      { t: 'unicode', cu: 0x42, delay: 0 }
    ])
  })

  it('只在纯可打印 ASCII + 换行时才走快路径', () => {
    expect(isPlainAsciiText('@TYPER1/D abc')).toBe(true)
    expect(isPlainAsciiText('a\nb')).toBe(true)
    expect(isPlainAsciiText('中文')).toBe(false)
    expect(isPlainAsciiText('a\tb')).toBe(false)
  })
})

describe('expectedEventCount', () => {
  it('按键 = 2 个事件，每个修饰键再 +2', () => {
    expect(expectedEventCount([{ t: 'key', vk: 0x41, mods: [], delay: 0 }])).toBe(2)
    expect(expectedEventCount([{ t: 'key', vk: 0x48, mods: ['shift'], delay: 0 }])).toBe(4)
    expect(expectedEventCount([{ t: 'key', vk: 0x56, mods: ['ctrl', 'shift'], delay: 0 }])).toBe(6)
  })

  it('Unicode 报文 = 2 个事件，wait 不算', () => {
    expect(expectedEventCount([{ t: 'unicode', cu: 0x4e2d, delay: 0 }])).toBe(2)
    expect(expectedEventCount([{ t: 'wait', ms: 100 }])).toBe(0)
  })
})

describe('encodeHostItems', () => {
  it('把动作编成等长的扁平数组（键位修饰键用位掩码表示）', () => {
    const batch = encodeHostItems([
      { t: 'key', vk: 0x41, mods: [], delay: 5 },
      { t: 'key', vk: 0x48, mods: ['shift'], delay: 0 },
      { t: 'unicode', cu: 0x4e2d, delay: 3 },
      { t: 'wait', ms: 120 }
    ])

    expect(batch.ops).toEqual([HOST_OP.key, HOST_OP.key, HOST_OP.unicode, HOST_OP.wait])
    expect(batch.vals).toEqual([0x41, 0x48, 0x4e2d, 0])
    expect(batch.mods).toEqual([0, MODIFIER_BITS.shift, 0, 0])
    // wait 动作的时长也走 delays，宿主只需一条"断批 + 等待"路径
    expect(batch.delays).toEqual([5, 0, 3, 120])
    expect(batch.ops).toHaveLength(batch.vals.length)
    expect(batch.ops).toHaveLength(batch.mods.length)
    expect(batch.ops).toHaveLength(batch.delays.length)
  })

  it('多个修饰键按位或到同一个掩码里', () => {
    const batch = encodeHostItems([{ t: 'key', vk: 0x56, mods: ['ctrl', 'alt'], delay: 0 }])
    expect(batch.mods[0]).toBe(MODIFIER_BITS.ctrl | MODIFIER_BITS.alt)
  })

  it('空批次编码成四个空数组', () => {
    expect(encodeHostItems([])).toEqual({ ops: [], vals: [], mods: [], delays: [] })
  })

  it('编码后的事件数仍与 expectedEventCount 一致', () => {
    const items = [
      { t: 'key' as const, vk: 0x48, mods: ['shift' as const], delay: 0 },
      { t: 'unicode' as const, cu: 0x4e2d, delay: 0 },
      { t: 'key' as const, vk: 0x0d, mods: [], delay: 0 }
    ]
    const batch = encodeHostItems(items)
    // 与宿主 C# 的口径一致：按键 2 个事件，每个修饰键再加 2 个；Unicode 报文 2 个
    const fromEncoded = batch.ops.reduce((sum, op, index) => {
      if (op === HOST_OP.wait) return sum
      if (op === HOST_OP.unicode) return sum + 2
      let modCount = 0
      for (const bit of [1, 2, 4, 8]) if ((batch.mods[index]! & bit) !== 0) modCount++
      return sum + 2 + 2 * modCount
    }, 0)
    expect(expectedEventCount(items)).toBe(fromEncoded)
  })
})

describe('assertInjectionResult', () => {
  it('注入数量匹配时通过', () => {
    expect(assertInjectionResult({ requested: 4, injected: 4, items: 2 }, 4)).toEqual({
      requested: 4,
      injected: 4,
      items: 2
    })
  })

  it('注入数量不足时报 E_INJECT_FAILED（UIPI / 安全软件）', () => {
    try {
      assertInjectionResult({ requested: 4, injected: 0 }, 4)
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('E_INJECT_FAILED')
      expect((error as ProtocolError).detail).toContain('管理员权限')
    }
  })

  it('返回内容格式不对时报 E_PARSE', () => {
    expect(() => assertInjectionResult(null, 1)).toThrow(ProtocolError)
    expect(() => assertInjectionResult({ injected: 1 }, 1)).toThrow(/缺少 injected/)
  })
})

describe('describeError', () => {
  it('已知错误码给出中文说明', () => {
    expect(describeError(new ProtocolError('E_TIMEOUT', 'x'))).toBe(ERROR_MESSAGES.E_TIMEOUT)
    expect(describeError(new ProtocolError('E_UNSUPPORTED_PLATFORM', 'x'))).toContain(
      '仅支持 Windows'
    )
  })

  it('未知错误码带上原始信息，普通 Error 直接用消息', () => {
    expect(describeError(new ProtocolError('E_???', 'boom'))).toContain('E_???')
    expect(describeError(new Error('普通错误'))).toBe('普通错误')
    expect(describeError('字符串')).toBe('字符串')
  })
})
