import { describe, expect, it } from 'vitest'
import { IpcValidationError, parseTransferPrepareRequest } from '@main/ipc/contracts'
import { TRANSFER_ENCODINGS } from '@shared/transfer/transfer'

describe('parseTransferPrepareRequest', () => {
  it('接受全部受支持的编码（白名单与界面选项同源，不会再出现"界面能选、主进程拒绝"）', () => {
    for (const encoding of TRANSFER_ENCODINGS) {
      const parsed = parseTransferPrepareRequest({
        path: 'C:\\temp\\a.bin',
        reuse: true,
        options: { encoding, chunkBytes: 8192, maxFrameChars: 24576 }
      })
      expect(parsed.options.encoding).toBe(encoding)
      expect(parsed.reuse).toBe(true)
    }
  })

  it('拒绝未知编码、缺路径与非正数参数', () => {
    const base = { path: 'C:\\temp\\a.bin', options: { chunkBytes: 8192, maxFrameChars: 24576 } }

    expect(() =>
      parseTransferPrepareRequest({ ...base, options: { ...base.options, encoding: 'rot13' } })
    ).toThrow(/不支持的编码/)
    expect(() => parseTransferPrepareRequest({ ...base, path: '  ' })).toThrow(IpcValidationError)
    expect(() =>
      parseTransferPrepareRequest({
        ...base,
        options: { encoding: 'gzb64', chunkBytes: 0, maxFrameChars: 24576 }
      })
    ).toThrow(IpcValidationError)
  })
})
