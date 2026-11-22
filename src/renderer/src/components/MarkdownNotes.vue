<script setup vapor lang="ts">
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

/**
 * 发布说明渲染：GitHub Release 的 body 是标准 GFM，直接当纯文本显示会把 `#`、`**`、列表全露出来。
 *
 * 两点是硬要求：
 * 1. 内容不可信 → 默认关掉内联 HTML，渲染结果再过一遍 DOMPurify，只留排版标签；
 * 2. 图片不加载远程资源（发布说明里常带徽章与截图，远程加载既慢又会暴露访问行为），链接一律
 *    交给系统浏览器打开，不在应用内导航。
 */
const props = defineProps<{
  /** Markdown 原文（GitHub Release body） */
  source: string
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
})

/**
 * GFM 任务列表：markdown-it 不识别 `- [x] 文案`，不处理会在列表里露出字面量方括号。
 * 这里把方括号换成只作标记的方框（勾选态加 `is-done`，样式见下方 `.task-box`）。
 */
md.core.ruler.after('inline', 'task-lists', (state) => {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i += 1) {
    if (tokens[i].type !== 'inline' || tokens[i - 2].type !== 'list_item_open') continue
    const first = tokens[i].children?.[0]
    if (!first || first.type !== 'text') continue
    const match = /^\[([ xX])\][ \t]+/.exec(first.content)
    if (!match) continue
    first.content = first.content.slice(match[0].length)
    const box = new state.Token('html_inline', '', 0)
    box.content = `<span class="task-box${match[1] === ' ' ? '' : ' is-done'}"></span>`
    tokens[i].children?.unshift(box)
  }
  return true
})

/** 允许保留的标签：只覆盖发布说明里会出现的排版元素 */
const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span'
]

/** 渲染并消毒后的 HTML；源为空时为空串（由模板回退到纯文本） */
const html = computed(() => {
  const text = props.source.trim()
  if (text.length === 0) return ''
  try {
    const cleaned = DOMPurify.sanitize(md.render(text), {
      ALLOWED_TAGS,
      // `title` 留给链接悬停提示；`class` 只用于任务列表标记（`html: false` 下外部写不了标签）
      ALLOWED_ATTR: ['href', 'title', 'class']
      // 协议白名单用 DOMPurify 的默认规则：它只对 URI 属性校验协议（`javascript:`、`data:` 一律拒绝），
      // 换成只认 http(s) 的自定义正则会连普通属性值一起判非法删掉
    })
    // 图片不加载远程资源，会被整段丢掉；只剩图片的段落因此成了空段落，去掉免得白占一行
    return cleaned.replace(/<p><\/p>\s*/g, '')
  } catch {
    // 极端输入导致渲染失败时退回纯文本，而不是让整块消失
    return ''
  }
})

/** 是否有可渲染内容 */
const rendered = computed(() => html.value.length > 0)

/**
 * @description 拦截链接点击：外链交给系统浏览器，应用内不跳转
 * @param event 鼠标事件
 */
function onClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a')
  if (!(anchor instanceof HTMLAnchorElement)) return
  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) void window.api.openExternal(href)
}
</script>

<template>
  <div class="notes">
    <!-- eslint-disable-next-line vue/no-v-html -- 已用 DOMPurify 消毒，且渲染时关闭了内联 HTML -->
    <div v-if="rendered" class="md" @click="onClick" v-html="html" />
    <pre v-else class="raw">{{ source }}</pre>
  </div>
</template>

<style scoped lang="scss">
.notes {
  max-height: 260px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.raw {
  margin: 0;
  font-family: var(--font-sans);
  white-space: pre-wrap;
  word-break: break-word;
}

.md {
  :deep(> :first-child) {
    margin-top: 0;
  }

  :deep(> :last-child) {
    margin-bottom: 0;
  }

  :deep(h1),
  :deep(h2),
  :deep(h3) {
    margin: 12px 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
  }

  :deep(h4),
  :deep(h5),
  :deep(h6) {
    margin: 10px 0 4px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-1);
  }

  :deep(p) {
    margin: 6px 0;
  }

  :deep(ul),
  :deep(ol) {
    margin: 6px 0;
    padding-left: 20px;
  }

  /* 项目符号被 Element Plus 的全局 reset 清掉（`ul, ol { list-style: none }`），这里恢复 */
  :deep(ul) {
    list-style: disc;
  }

  :deep(ol) {
    list-style: decimal;
  }

  :deep(li) {
    margin: 2px 0;
  }

  /* GFM 任务列表：标记用自绘方框（原生禁用复选框会被浏览器灰化，看不出是否勾选） */
  :deep(li:has(> .task-box)) {
    list-style: none;
  }

  :deep(.task-box) {
    position: relative;
    display: inline-block;
    width: 12px;
    height: 12px;
    margin: 0 5px 0 -17px;
    border: 1px solid var(--stroke-strong);
    border-radius: 3px;
    vertical-align: -2px;
  }

  :deep(.task-box.is-done) {
    border-color: var(--accent);
    background: var(--accent);

    /* 两条边框拼出对勾，颜色跟随主题的强调色前景 */
    &::after {
      content: '';
      position: absolute;
      inset: 0;
      width: 4px;
      height: 7px;
      margin: auto;
      border: solid var(--on-accent);
      border-width: 0 1.5px 1.5px 0;
      transform: rotate(45deg) translate(-0.5px, -1px);
    }
  }

  :deep(code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--hover-fill, rgba(127, 127, 127, 0.14));
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
  }

  :deep(pre) {
    margin: 8px 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm, 6px);
    background: var(--hover-fill, rgba(127, 127, 127, 0.14));
    overflow-x: auto;

    code {
      padding: 0;
      background: none;
      white-space: pre;
    }
  }

  :deep(blockquote) {
    margin: 8px 0;
    padding: 2px 10px;
    border-left: 2px solid var(--stroke);
    color: var(--text-3);
  }

  :deep(hr) {
    margin: 10px 0;
    border: none;
    border-top: 1px solid var(--stroke);
  }

  :deep(a) {
    color: var(--accent);
    text-decoration: none;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
    }
  }

  :deep(table) {
    width: 100%;
    margin: 8px 0;
    border-collapse: collapse;
    font-size: 12px;
  }

  :deep(th),
  :deep(td) {
    padding: 4px 8px;
    border: 1px solid var(--stroke);
    text-align: left;
  }

  :deep(th) {
    font-weight: 600;
    color: var(--text-1);
  }
}
</style>
