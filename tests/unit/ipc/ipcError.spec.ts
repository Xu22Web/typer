import { describe, expect, it } from 'vitest'
import { cleanIpcErrorMessage, cleanMessage, toIpcError } from '@main/ipc/ipcError'

describe('cleanMessage', () => {
  it('剥掉 Electron 的远程调用包装', () => {
    expect(
      cleanMessage(
        "Error invoking remote method 'settings:set': Error: 设置保存失败：EPERM: operation not permitted"
      )
    ).toBe('设置保存失败：EPERM: operation not permitted')
  })

  it('剥掉多余的 Error: 前缀（含多层嵌套）', () => {
    expect(cleanMessage('Error: Error: 读取失败')).toBe('读取失败')
  })

  it('没有包装时原样返回（仅去首尾空白）', () => {
    expect(cleanMessage('  设置保存失败：磁盘已满  ')).toBe('设置保存失败：磁盘已满')
    expect(cleanMessage('设置保存失败')).toBe('设置保存失败')
  })

  it('不同频道名的包装都能处理', () => {
    expect(
      cleanMessage("Error invoking remote method 'typing:start': Error: 已有输入任务正在进行")
    ).toBe('已有输入任务正在进行')
    expect(cleanMessage("Error invoking remote method 'files:import': Error: 文件过大")).toBe(
      '文件过大'
    )
  })

  it('空内容回退成可读文案，避免界面出现空白错误', () => {
    expect(cleanMessage('')).toBe('未知错误')
    expect(cleanMessage('   ')).toBe('未知错误')
    expect(cleanMessage('Error:')).toBe('未知错误')
  })

  it('不会误伤正文里出现的 Error 字样', () => {
    expect(cleanMessage('注入失败：SendInput 返回 0（见 Error 日志）')).toBe(
      '注入失败：SendInput 返回 0（见 Error 日志）'
    )
  })
})

describe('cleanIpcErrorMessage', () => {
  it('处理 Error 实例', () => {
    expect(
      cleanIpcErrorMessage(new Error("Error invoking remote method 'x': Error: 真正原因"))
    ).toBe('真正原因')
  })

  it('处理非 Error 抛出物', () => {
    expect(cleanIpcErrorMessage('字符串错误')).toBe('字符串错误')
    expect(cleanIpcErrorMessage(undefined)).toBe('undefined')
  })
})

describe('toIpcError', () => {
  it('返回带清理后消息的 Error', () => {
    const error = toIpcError(
      new Error("Error invoking remote method 'settings:set': Error: 磁盘不可写")
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('磁盘不可写')
  })
})
