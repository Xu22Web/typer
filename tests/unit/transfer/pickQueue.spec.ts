import { describe, expect, it } from 'vitest'

import { createPickQueue, parsePickQueue } from '../../../src/main/transfer/pickQueue'

describe('parsePickQueue', () => {
  it('把分号分隔的路径拆成有序队列', () => {
    expect(parsePickQueue('C:\\a.txt;D:\\b.bin')).toEqual(['C:\\a.txt', 'D:\\b.bin'])
  })

  it('忽略空条目与首尾空白', () => {
    expect(parsePickQueue(' ; C:\\a.txt ; ; D:\\b.bin ; ')).toEqual(['C:\\a.txt', 'D:\\b.bin'])
  })

  it('未设置或空串时返回空队列', () => {
    expect(parsePickQueue(undefined)).toEqual([])
    expect(parsePickQueue('')).toEqual([])
  })
})

describe('createPickQueue', () => {
  it('按顺序逐个消费，用尽后返回 undefined（交回真实对话框）', () => {
    const queue = createPickQueue('C:\\a.txt;D:\\b.bin')
    expect(queue.next()).toBe('C:\\a.txt')
    expect(queue.next()).toBe('D:\\b.bin')
    expect(queue.next()).toBeUndefined()
  })

  it('把减号解释为用户取消', () => {
    const queue = createPickQueue('-;C:\\a.txt')
    expect(queue.next()).toBeNull()
    expect(queue.next()).toBe('C:\\a.txt')
  })

  it('关闭后完全不接管', () => {
    const queue = createPickQueue('C:\\a.txt', false)
    expect(queue.next()).toBeUndefined()
  })
})
