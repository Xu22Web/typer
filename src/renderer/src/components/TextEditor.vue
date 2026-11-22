<script setup lang="ts" vapor>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth
} from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  placeholder as placeholderExt
} from '@codemirror/view'

/**
 * 内容区编辑器。
 *
 * 用 CodeMirror 而不是 textarea：它只渲染视口内的行，几万字符编辑、滚动都不会整块重排；
 * textarea 在同样长度下要维护整段文本布局，且 Electron 默认开启拼写检查，长文本明显掉帧。
 *
 * `maxLength` 与 textarea 的 maxlength 同语义：超出的部分直接从尾部截掉，
 * 粘贴超长文本时一次性截断，不会让上层拿到越过上限的内容。
 */
const props = defineProps<{
  modelValue: string
  maxLength: number
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  start: []
}>()

/** CodeMirror 的挂载点 */
const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
/** 外部回写 doc 时置位，避免把同一次改动再 emit 回父组件 */
let syncing = false

/** 右键菜单的位置与可用项（可用性在弹出时算一次，菜单打开期间不变） */
interface MenuState {
  x: number
  y: number
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
}

const menu = ref<MenuState | null>(null)

/**
 * @description 在鼠标位置弹出菜单；贴着视口边缘时向内收，避免溢出
 * @param event 右键事件
 * @param editor 当前编辑器实例
 */
function showMenu(event: MouseEvent, editor: EditorView): void {
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 176),
    y: Math.min(event.clientY, window.innerHeight - 232),
    canUndo: undoDepth(editor.state) > 0,
    canRedo: redoDepth(editor.state) > 0,
    hasSelection: !editor.state.selection.main.empty
  }
}

/** @description 关闭菜单（点击外部、Esc、滚动、窗口尺寸变化都会调用） */
function closeMenu(): void {
  if (menu.value) menu.value = null
}

/**
 * @description 执行菜单项：先关菜单再操作，最后把焦点还给编辑器
 * @param action 菜单动作
 */
async function runMenu(
  action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
): Promise<void> {
  const editor = view
  closeMenu()
  if (!editor) return
  const { from, to } = editor.state.selection.main

  try {
    if (action === 'undo') undo(editor)
    else if (action === 'redo') redo(editor)
    else if (action === 'selectAll') selectAll(editor)
    else if (action === 'copy') {
      if (from !== to) await navigator.clipboard.writeText(editor.state.sliceDoc(from, to))
    } else if (action === 'cut') {
      if (from !== to) {
        await navigator.clipboard.writeText(editor.state.sliceDoc(from, to))
        editor.dispatch(editor.state.replaceSelection(''))
      }
    } else {
      const text = await navigator.clipboard.readText()
      if (text.length > 0) editor.dispatch(editor.state.replaceSelection(text))
    }
  } catch {
    ElMessage.warning(action === 'paste' ? '无法读取剪贴板，请用 Ctrl+V' : '无法写入剪贴板')
  }

  editor.focus()
}

/** @description 点击页面其它地方时关闭菜单 */
function onDocumentPointerDown(): void {
  closeMenu()
}

/** @description Esc 关闭菜单 */
function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => {
  if (!host.value) return
  view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        lineNumbers(),
        keymap.of([
          { key: 'Ctrl-Enter', run: () => (emit('start'), true) },
          ...historyKeymap,
          ...defaultKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || syncing) return
          const doc = update.state.doc
          // 超出上限：先截掉尾部再上报，等价于 textarea 的 maxlength
          if (doc.length > props.maxLength) {
            view?.dispatch({ changes: { from: props.maxLength, to: doc.length, insert: '' } })
            return
          }
          emit('update:modelValue', doc.toString())
        }),
        // Electron 默认不提供右键菜单：自己接管，菜单项与快捷键一致
        EditorView.domEventHandlers({
          contextmenu(event, editor) {
            event.preventDefault()
            showMenu(event, editor)
            return true
          }
        }),
        ...(props.placeholder ? [placeholderExt(props.placeholder)] : [])
      ]
    }),
    parent: host.value
  })

  window.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('keydown', onDocumentKeyDown)
  window.addEventListener('scroll', closeMenu, true)
  window.addEventListener('resize', closeMenu)
})

watch(
  () => props.modelValue,
  (value) => {
    const current = view?.state.doc.toString() ?? ''
    if (current === value) return
    syncing = true
    try {
      view?.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    } finally {
      syncing = false
    }
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('keydown', onDocumentKeyDown)
  window.removeEventListener('scroll', closeMenu, true)
  window.removeEventListener('resize', closeMenu)
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="host" class="text-editor" />
  <Teleport to="body">
    <div
      v-if="menu"
      class="cm-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <button type="button" :disabled="!menu.canUndo" @click="runMenu('undo')">撤销</button>
      <button type="button" :disabled="!menu.canRedo" @click="runMenu('redo')">重做</button>
      <div class="cm-menu-sep" />
      <button type="button" :disabled="!menu.hasSelection" @click="runMenu('cut')">剪切</button>
      <button type="button" :disabled="!menu.hasSelection" @click="runMenu('copy')">复制</button>
      <button type="button" @click="runMenu('paste')">粘贴</button>
      <div class="cm-menu-sep" />
      <button type="button" @click="runMenu('selectAll')">全选</button>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.text-editor {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  /*
   * 按 Fluent 的“控件填充”语义取色，不用页面底色：
   * · 深色主题：--ctrl-fill（白 6%）叠在卡片上比卡片亮一档，是 Win11 输入框的 subtle fill；
   * · 浅色主题：--ctrl-fill（白 70%）叠在白卡片上仍是白，靠 1px 描边区分——与 Win11 一致。
   * 描边取 --stroke-hover（两主题都是 20% 对比），比卡片的 --stroke 高一档，能看清边界。
   */
  border: 1px solid var(--stroke-hover);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
  transition:
    border-color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);

  &:hover {
    background: var(--ctrl-fill-hover);
  }

  /* 聚焦用强调色描边，与其它输入控件同一套反馈 */
  &:focus-within {
    border-color: var(--accent-border);
    box-shadow: 0 0 0 1px var(--accent-border);
  }

  /* 外层只分配高度，滚动交给 CodeMirror 自己 */
  :deep(.cm-editor) {
    width: 100%;
    height: 100%;
    font-family: inherit;
    font-size: 13px;
    background: transparent;
  }

  :deep(.cm-editor.cm-focused) {
    outline: none;
  }

  :deep(.cm-scroller) {
    line-height: 1.7;
  }

  /*
   * 行号装订线：与正文同底色，只留一条分隔线。
   *
   * 这里**不能**给 gutter 加 padding：CodeMirror 已经把 `.cm-content` 的上下 padding
   * 计入行号起点（spacer 高度），自己再加一份会让整列行号下移同样的距离、与正文错开。
   */
  :deep(.cm-gutters) {
    border-right: 1px solid var(--stroke-strong);
    background: transparent;
    color: var(--text-3);
    user-select: none;
  }

  :deep(.cm-lineNumbers .cm-gutterElement) {
    padding: 0 8px 0 12px;
    min-width: 30px;
    text-align: right;
  }

  /*
   * CodeMirror 自带 light/dark 两套基础主题（光标黑/白、选区浅紫），
   * 这里统一用项目 token 覆盖：scoped 的 :deep 选择器带 data-v 属性，特异性高于它的基础样式。
   */
  :deep(.cm-content) {
    padding: 10px 12px;
    color: var(--text-1);
    caret-color: var(--accent);
  }

  :deep(.cm-selectionLayer .cm-selectionBackground) {
    background: var(--accent-soft);
  }

  :deep(.cm-placeholder) {
    color: var(--text-2);
  }
}

/*
 * 右键菜单：Teleport 到 body，样式仍带 scoped 属性；
 * 取浮层色 + 一层柔和投影，与设置页的弹出层同一套观感。
 */
.cm-menu {
  position: fixed;
  z-index: 3000;
  min-width: 168px;
  padding: 4px;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--radius-md);
  background: var(--layer-bg);
  box-shadow: var(--shadow-flyout);
  font-size: 13px;
  user-select: none;

  button {
    display: flex;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-1);
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--ctrl-fill-hover);
    }

    &:disabled {
      color: var(--text-3);
      cursor: default;
    }
  }
}

.cm-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--stroke);
}
</style>
