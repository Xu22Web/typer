import { describe, expect, it } from 'vitest'
import { IpcValidationError, parseTransferPrepareRequest } from '@main/ipc/contracts'
import {
  TRANSFER_ALPHABETS,
  TRANSFER_COMPRESSIONS,
  TRANSFER_TARGET_MODES
} from '@shared/transfer/transfer'

/**
 * @description 造一份合法的准备请求
 * @param overrides 覆盖选项字段
 * @returns 请求载荷
 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'C:\\temp\\a.bin',
    reuse: true,
    options: {
      alphabet: 'ascii32',
      compression: 'auto',
      quality: 9,
      mode: 'term',
      chunkBytes: 16384,
      maxFrameChars: 65536,
      ...overrides
    }
  }
}

describe('parseTransferPrepareRequest', () => {
  it('接受全部受支持的字符档 / 压缩方式 / 目标端（白名单与界面选项同源）', () => {
    for (const alphabet of TRANSFER_ALPHABETS) {
      for (const compression of TRANSFER_COMPRESSIONS) {
        for (const mode of TRANSFER_TARGET_MODES) {
          const parsed = parseTransferPrepareRequest(payload({ alphabet, compression, mode }))
          expect(parsed.options.alphabet).toBe(alphabet)
          expect(parsed.options.compression).toBe(compression)
          expect(parsed.options.mode).toBe(mode)
          expect(parsed.reuse).toBe(true)
        }
      }
    }
  })

  it('拒绝未知字符档 / 压缩方式 / 目标端', () => {
    expect(() => parseTransferPrepareRequest(payload({ alphabet: 'b64' }))).toThrow(/符号表/)
    expect(() => parseTransferPrepareRequest(payload({ compression: 'gzip' }))).toThrow(/压缩/)
    expect(() => parseTransferPrepareRequest(payload({ mode: 'terminal' }))).toThrow(/目标端/)
  })

  it('拒绝缺路径与非正数参数', () => {
    expect(() => parseTransferPrepareRequest({ ...payload(), path: '  ' })).toThrow(
      IpcValidationError
    )
    expect(() => parseTransferPrepareRequest(payload({ chunkBytes: 0 }))).toThrow(
      IpcValidationError
    )
    expect(() => parseTransferPrepareRequest(payload({ maxFrameChars: -1 }))).toThrow(
      IpcValidationError
    )
    expect(() => parseTransferPrepareRequest(payload({ quality: 0 }))).toThrow(IpcValidationError)
  })

  it('请求本身不是对象时报错', () => {
    expect(() => parseTransferPrepareRequest(null)).toThrow(IpcValidationError)
    expect(() => parseTransferPrepareRequest('x')).toThrow(IpcValidationError)
  })
})
