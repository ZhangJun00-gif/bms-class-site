<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ImagePlus,
  Images,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Underline,
  Undo2,
  X,
} from 'lucide-vue-next';
import { api, formatError, uploadForm } from '../../lib/api';
import { sanitizePastedHtml } from '../../lib/newsHtml';
import type { Album, AlbumListResponse, Photo } from '../../types';
import BaseDialog from '../common/BaseDialog.vue';
import EmptyState from '../common/EmptyState.vue';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_INPUT_SIZE = 10 * 1024 * 1024;

type NoticeTone = 'info' | 'success' | 'error';
interface EditorNotice {
  tone: NoticeTone;
  text: string;
}

interface UploadItem {
  id: number;
  name: string;
  percent: number | null;
  status: 'uploading' | 'done' | 'failed' | 'cancelled';
  message: string;
}

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const editor = ref<HTMLDivElement>();
const fileInput = ref<HTMLInputElement>();
const albums = ref<Album[]>([]);
const albumId = ref('');
const caption = ref('');
const galleryOpen = ref(false);
const loadingAlbums = ref(false);
const uploading = ref(false);
const uploads = ref<UploadItem[]>([]);
const notice = ref<EditorNotice | null>(null);
let savedRange: Range | null = null;
let noticeTimer: number | undefined;
let uploadSeq = 0;
let activeUploadController: AbortController | null = null;
let destroyed = false;
// 上传会话令牌：表单内容被外部重置（切换记录/归档/重载服务器版本）时递增，
// 使进行中的上传完成回调不再向新内容插入旧图片
let uploadSession = 0;

watch(
  () => props.modelValue,
  async (value) => {
    await nextTick();
    if (editor.value && editor.value.innerHTML !== value) {
      if (uploading.value) uploadSession += 1;
      editor.value.innerHTML = value;
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (editor.value) editor.value.innerHTML = props.modelValue;
  void loadAlbums();
});

onBeforeUnmount(() => {
  destroyed = true;
  // 中止进行中的上传：服务端已落对象由宽限期回收流程处理
  activeUploadController?.abort();
  if (noticeTimer) window.clearTimeout(noticeTimer);
});

/** 浮动状态条：成功/提示自动消退，错误保留到下次操作或手动关闭 */
function showNotice(tone: NoticeTone, text: string, autoClear = 0) {
  notice.value = { tone, text };
  if (noticeTimer) window.clearTimeout(noticeTimer);
  if (autoClear > 0) {
    noticeTimer = window.setTimeout(() => {
      notice.value = null;
    }, autoClear);
  }
}

function dismissNotice() {
  notice.value = null;
  if (noticeTimer) window.clearTimeout(noticeTimer);
}

function syncValue() {
  // 卸载后不再向外同步，避免把空内容 emit 给父级清掉草稿
  if (!editor.value) return;
  emit('update:modelValue', editor.value.innerHTML);
  rememberSelection();
}

function rememberSelection() {
  const selection = window.getSelection();
  if (
    !editor.value ||
    !selection?.rangeCount ||
    !selection.anchorNode ||
    !editor.value.contains(selection.anchorNode)
  )
    return;
  savedRange = selection.getRangeAt(0).cloneRange();
}

function restoreSelection() {
  editor.value?.focus();
  const selection = window.getSelection();
  if (!selection || !editor.value) return;
  if (!savedRange) {
    savedRange = document.createRange();
    savedRange.selectNodeContents(editor.value);
    savedRange.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(savedRange);
}

function command(name: string, value?: string) {
  restoreSelection();
  document.execCommand(name, false, value);
  syncValue();
}

function insertHtml(html: string) {
  restoreSelection();
  document.execCommand('insertHTML', false, html);
  syncValue();
}

async function loadAlbums() {
  if (loadingAlbums.value) return;
  loadingAlbums.value = true;
  try {
    // 编辑器画廊需要各相册的完整照片列表，走管理端全量模式
    const result = await api<AlbumListResponse>('/albums?includePhotos=true');
    albums.value = result.items;
  } catch {
    albums.value = [];
  } finally {
    loadingAlbums.value = false;
  }
}

function chooseFiles() {
  rememberSelection();
  fileInput.value?.click();
}

async function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  await uploadFiles(files);
}

async function onPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith('image/'),
  );
  if (files.length) {
    event.preventDefault();
    rememberSelection();
    await uploadFiles(files);
    return;
  }
  // 富文本粘贴：仅保留受支持的基本格式，丢弃脚本与 base64 图片
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (!html) return;
  event.preventDefault();
  const { html: clean, droppedMedia } = sanitizePastedHtml(html);
  if (clean) insertHtml(clean);
  if (droppedMedia)
    showNotice('info', '已移除粘贴内容中的图片，请通过上传或从相册插入', 4500);
}

async function onDrop(event: DragEvent) {
  // 始终阻止浏览器默认行为（直接打开文件导致页面跳转）
  event.preventDefault();
  const dropped = Array.from(event.dataTransfer?.files ?? []);
  if (!dropped.length) return;
  const files = dropped.filter((file) => file.type.startsWith('image/'));
  if (!files.length) {
    showNotice(
      'error',
      `「${dropped[0]!.name}」不是图片文件，仅支持 JPEG、PNG 或 WebP`,
    );
    return;
  }
  placeCaretAtPoint(event.clientX, event.clientY);
  await uploadFiles(files);
}

/** 尽量把插入点放到拖放落点，不支持时退回最近光标位置 */
function placeCaretAtPoint(x: number, y: number) {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (doc.caretRangeFromPoint) {
    range = doc.caretRangeFromPoint(x, y);
  } else if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  }
  if (range && editor.value?.contains(range.startContainer)) {
    savedRange = range;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    rememberSelection();
  }
}

async function uploadFiles(files: File[]) {
  if (!files.length) return;
  if (uploading.value) {
    showNotice('info', '正在上传其他图片，请等待完成后再试');
    return;
  }
  const valid: File[] = [];
  let firstProblem = '';
  for (const file of files) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      firstProblem ||= `「${file.name}」格式不支持，仅支持 JPEG、PNG 或 WebP 图片`;
      continue;
    }
    if (file.size > MAX_INPUT_SIZE) {
      firstProblem ||= `「${file.name}」超过 10MB 大小限制`;
      continue;
    }
    valid.push(file);
  }
  if (!valid.length) {
    showNotice('error', firstProblem || '没有可上传的图片');
    return;
  }

  uploading.value = true;
  dismissNotice();
  uploads.value = [];
  const failedNames: string[] = [];
  let inserted = 0;
  let cancelled = false;
  const session = uploadSession;
  try {
    for (const file of valid) {
      const item = reactive<UploadItem>({
        id: ++uploadSeq,
        name: file.name,
        percent: null,
        status: 'uploading',
        message: '',
      });
      uploads.value.push(item);
      const controller = new AbortController();
      activeUploadController = controller;
      try {
        const form = new FormData();
        form.append('file', file);
        if (albumId.value) form.append('albumId', albumId.value);
        const captionText = caption.value.trim();
        if (captionText) form.append('caption', captionText);
        const photo = await uploadForm<Photo>('/news/images', form, {
          signal: controller.signal,
          onProgress: (progress) => {
            item.percent = progress.percent;
          },
        });
        // 组件卸载或表单被外部重置后，迟到的上传不得再插入正文
        if (destroyed || session !== uploadSession) {
          item.status = 'cancelled';
          cancelled = true;
          break;
        }
        item.status = 'done';
        item.percent = 100;
        insertPhoto(photo, file.name);
        inserted += 1;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          // 取消只影响当前这张，已经成功插入的图片保留
          item.status = 'cancelled';
          cancelled = true;
          break;
        }
        item.status = 'failed';
        item.message = formatError(caught, '上传失败');
        failedNames.push(`「${file.name}」`);
      } finally {
        if (activeUploadController === controller)
          activeUploadController = null;
      }
    }
    if (albumId.value && inserted) await loadAlbums();
    if (failedNames.length) {
      const prefix = inserted ? `已插入 ${inserted} 张；` : '';
      const suffix = firstProblem ? `；${firstProblem}` : '';
      showNotice(
        'error',
        `${prefix}${failedNames.join('、')}上传失败${suffix}`,
      );
    } else if (cancelled) {
      showNotice(
        'info',
        inserted
          ? `已取消上传，已保留成功插入的 ${inserted} 张图片`
          : '已取消上传',
      );
    } else if (firstProblem) {
      showNotice('error', `${firstProblem}；其余 ${inserted} 张已插入`);
    } else {
      showNotice(
        'success',
        inserted > 1 ? `已插入 ${inserted} 张图片` : '图片已插入正文',
        3500,
      );
    }
  } finally {
    uploading.value = false;
    activeUploadController = null;
  }
}

/** 取消当前正在上传的一张图片；已插入的图片不受影响 */
function cancelActiveUpload() {
  activeUploadController?.abort();
}

// 父级据此在图片上传进行中禁用提交，避免发布内容缺失在途图片
defineExpose({ uploading });

function removeUploadItem(item: UploadItem) {
  const index = uploads.value.indexOf(item);
  if (index >= 0 && item.status !== 'uploading')
    uploads.value.splice(index, 1);
}

function insertPhoto(photo: Photo, alt = '') {
  const captionText = photo.caption?.trim() ?? '';
  const figcaption = captionText
    ? `<figcaption>${escapeAttribute(captionText)}</figcaption>`
    : '';
  insertHtml(
    `<figure><img src="${escapeAttribute(photo.url)}" alt="${escapeAttribute(alt || photo.caption)}" data-photo-id="${escapeAttribute(photo.id)}">${figcaption}</figure><p><br></p>`,
  );
  galleryOpen.value = false;
}

async function openGallery() {
  rememberSelection();
  galleryOpen.value = true;
  await loadAlbums();
}

function escapeAttribute(value = '') {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
</script>

<template>
  <div class="rich-editor">
    <div
      class="editor-toolbar"
      role="toolbar"
      aria-label="正文格式工具栏"
      @mousedown="rememberSelection"
    >
      <select
        aria-label="段落样式"
        title="段落样式"
        @change="
          command('formatBlock', ($event.target as HTMLSelectElement).value)
        "
      >
        <option value="p">正文</option>
        <option value="h2">二级标题</option>
        <option value="h3">三级标题</option>
      </select>
      <span class="tool-group">
        <button
          type="button"
          class="editor-tool"
          title="粗体"
          aria-label="粗体"
          @mousedown.prevent="command('bold')"
        >
          <Bold :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="斜体"
          aria-label="斜体"
          @mousedown.prevent="command('italic')"
        >
          <Italic :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="下划线"
          aria-label="下划线"
          @mousedown.prevent="command('underline')"
        >
          <Underline :size="17" />
        </button>
      </span>
      <span class="tool-group">
        <button
          type="button"
          class="editor-tool"
          title="无序列表"
          aria-label="无序列表"
          @mousedown.prevent="command('insertUnorderedList')"
        >
          <List :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="有序列表"
          aria-label="有序列表"
          @mousedown.prevent="command('insertOrderedList')"
        >
          <ListOrdered :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="引用"
          aria-label="引用"
          @mousedown.prevent="command('formatBlock', 'blockquote')"
        >
          <Quote :size="17" />
        </button>
      </span>
      <span class="tool-group">
        <button
          type="button"
          class="editor-tool"
          title="左对齐"
          aria-label="左对齐"
          @mousedown.prevent="command('justifyLeft')"
        >
          <AlignLeft :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="居中"
          aria-label="居中"
          @mousedown.prevent="command('justifyCenter')"
        >
          <AlignCenter :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="右对齐"
          aria-label="右对齐"
          @mousedown.prevent="command('justifyRight')"
        >
          <AlignRight :size="17" />
        </button>
      </span>
      <span class="tool-group color-tools" aria-label="文字颜色">
        <button
          type="button"
          class="color-swatch ink"
          title="深色文字"
          aria-label="深色文字"
          @mousedown.prevent="command('foreColor', '#152238')"
        />
        <button
          type="button"
          class="color-swatch primary"
          title="藏青文字"
          aria-label="藏青文字"
          @mousedown.prevent="command('foreColor', '#26397d')"
        />
        <button
          type="button"
          class="color-swatch accent"
          title="医青文字"
          aria-label="医青文字"
          @mousedown.prevent="command('foreColor', '#0a6570')"
        />
      </span>
      <span class="tool-group">
        <button
          type="button"
          class="editor-tool"
          title="撤销"
          aria-label="撤销"
          @mousedown.prevent="command('undo')"
        >
          <Undo2 :size="17" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="重做"
          aria-label="重做"
          @mousedown.prevent="command('redo')"
        >
          <Redo2 :size="17" />
        </button>
      </span>
      <span class="image-tools">
        <select
          v-model="albumId"
          aria-label="图片同时加入相册"
          title="图片同时加入相册"
        >
          <option value="">不加入相册</option>
          <option v-for="album in albums" :key="album.id" :value="album.id">
            {{ album.title }}
          </option>
        </select>
        <input
          v-model="caption"
          class="caption-input"
          type="text"
          maxlength="300"
          placeholder="图片说明（可选）"
          aria-label="图片说明（可选）"
          title="上传图片时附带的说明文字"
        />
        <button
          type="button"
          class="editor-tool"
          title="上传图片"
          aria-label="上传图片"
          :disabled="uploading"
          @click="chooseFiles"
        >
          <ImagePlus :size="18" />
        </button>
        <button
          type="button"
          class="editor-tool"
          title="从相册插入"
          aria-label="从相册插入"
          @click="openGallery"
        >
          <Images :size="18" />
        </button>
      </span>
      <input
        ref="fileInput"
        class="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        @change="onFilesPicked"
      />
    </div>

    <div
      ref="editor"
      class="editor-surface rich-text"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      aria-label="动态正文"
      data-placeholder="输入正文"
      @input="syncValue"
      @keyup="rememberSelection"
      @mouseup="rememberSelection"
      @focus="rememberSelection"
      @paste="onPaste"
      @dragover.prevent
      @drop="onDrop"
    />

    <!-- 逐项上传状态：进行时可取消当前项，失败项保留原因 -->
    <ul v-if="uploads.length" class="upload-list" aria-label="图片上传状态">
      <li
        v-for="item in uploads"
        :key="item.id"
        class="upload-item"
        :class="item.status"
      >
        <span class="upload-name">{{ item.name }}</span>
        <span class="upload-state" :role="item.status === 'failed' ? 'alert' : undefined">
          <template v-if="item.status === 'uploading'">
            上传中{{ item.percent != null ? ` ${item.percent}%` : '…' }}
          </template>
          <template v-else-if="item.status === 'done'">已插入</template>
          <template v-else-if="item.status === 'cancelled'">已取消</template>
          <template v-else>失败：{{ item.message }}</template>
        </span>
        <button
          v-if="item.status === 'uploading'"
          type="button"
          class="upload-action"
          :aria-label="`取消上传 ${item.name}`"
          @click="cancelActiveUpload"
        >
          取消
        </button>
        <button
          v-else
          type="button"
          class="upload-action dismiss"
          :aria-label="`清除 ${item.name} 的上传记录`"
          @click="removeUploadItem(item)"
        >
          <X :size="12" />
        </button>
      </li>
    </ul>

    <!-- 浮动状态条：不占据文档流，避免编辑区高度跳动 -->
    <div class="editor-notices" aria-live="polite">
      <p
        v-if="notice"
        class="editor-notice"
        :class="notice.tone"
        :role="notice.tone === 'error' ? 'alert' : 'status'"
      >
        <span class="notice-text">{{ notice.text }}</span>
        <button
          v-if="!uploading"
          type="button"
          class="notice-dismiss"
          aria-label="关闭提示"
          @click="dismissNotice"
        >
          <X :size="13" />
        </button>
      </p>
    </div>

    <BaseDialog
      :open="galleryOpen"
      title="从相册插入"
      :width="820"
      @close="galleryOpen = false"
    >
      <p v-if="loadingAlbums" class="gallery-loading" role="status">
        正在加载相册…
      </p>
      <EmptyState
        v-else-if="!albums.some((album) => album.photos.length)"
        title="相册中暂无照片"
      />
      <div v-else class="gallery-list">
        <section
          v-for="album in albums.filter((item) => item.photos.length)"
          :key="album.id"
          class="gallery-group"
        >
          <h3>{{ album.title }}</h3>
          <div class="gallery-grid">
            <button
              v-for="photo in album.photos"
              :key="photo.id"
              type="button"
              @click="insertPhoto(photo)"
            >
              <img
                :src="photo.url"
                :alt="photo.caption || album.title"
                loading="lazy"
                decoding="async"
              />
            </button>
          </div>
        </section>
      </div>
    </BaseDialog>
  </div>
</template>

<style scoped>
.rich-editor {
  position: relative;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  overflow: hidden;
  transition:
    border-color 0.16s var(--ease-out),
    box-shadow 0.16s var(--ease-out);
}

.rich-editor:focus-within {
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.rich-editor input.sr-only {
  width: 1px;
  height: 1px;
  min-height: 0;
  padding: 0;
  border: 0;
}

/* 工具栏分组换行：任何宽度下都不需要横向滚动 */
.editor-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 48px;
  padding: 7px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-muted);
}

.editor-toolbar select {
  width: auto;
  min-width: 88px;
  height: 34px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  padding: 0 28px 0 9px;
  background: var(--surface);
  font-size: 12px;
}

.tool-group {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding-right: 6px;
  border-right: 1px solid var(--border-strong);
}

.image-tools {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

@media (min-width: 681px) {
  .image-tools {
    margin-left: auto;
  }
}

.caption-input {
  flex: 0 1 150px;
  min-width: 110px;
  max-width: 190px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  padding: 0 10px;
  background: var(--surface);
  font-size: 12px;
}

.caption-input:focus {
  outline: none;
  border-color: var(--accent);
}

.editor-tool {
  width: 34px;
  height: 34px;
  flex: none;
  display: inline-grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
}

.editor-tool:hover {
  border-color: var(--border-strong);
  background: var(--surface);
  color: var(--primary);
}

.editor-tool:disabled {
  opacity: 0.5;
  cursor: wait;
}

.color-tools {
  align-items: center;
  padding-left: 4px;
}

.color-swatch {
  width: 22px;
  height: 22px;
  border: 3px solid var(--surface-muted);
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--border-strong);
  cursor: pointer;
}

.color-swatch.ink {
  background: var(--ink);
}

.color-swatch.primary {
  background: var(--primary);
}

.color-swatch.accent {
  background: var(--accent-dark);
}

.editor-surface {
  min-height: 360px;
  max-width: none;
  padding: 24px;
  outline: none;
  overflow-x: clip;
}

.editor-surface:empty::before {
  content: attr(data-placeholder);
  color: var(--muted);
  pointer-events: none;
}

/* 逐项上传状态列表 */
.upload-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
  list-style: none;
}

.upload-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
}

.upload-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-state {
  flex: none;
  color: var(--muted);
}

.upload-item.failed .upload-state {
  color: var(--danger);
}

.upload-item.done .upload-state {
  color: var(--success);
}

.upload-action {
  flex: none;
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 12px;
  cursor: pointer;
}

.upload-action:hover {
  border-color: var(--border-strong);
  color: var(--primary);
}

.upload-action.dismiss {
  padding: 0;
  width: 22px;
}

/* 浮动状态条：绝对定位于编辑区右下角，不引起布局跳动 */
.editor-notices {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 1;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}

.editor-notice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: min(320px, calc(100% - 8px));
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  box-shadow: var(--shadow-m);
  font-size: 12px;
  line-height: 1.5;
  pointer-events: auto;
}

.editor-notice.info {
  color: var(--accent-dark);
  border-color: #b3dade;
  background: var(--info-bg);
}

.editor-notice.success {
  color: var(--success);
  border-color: var(--success-border);
  background: var(--success-bg);
}

.editor-notice.error {
  color: var(--danger);
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.notice-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.notice-dismiss {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.notice-dismiss:hover {
  background: rgba(20, 31, 75, 0.08);
}

.gallery-loading {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.gallery-list {
  display: grid;
  gap: var(--space-6);
}

.gallery-group h3 {
  margin: 0 0 var(--space-3);
  font-size: 16px;
}

.gallery-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.gallery-grid button {
  aspect-ratio: 4 / 3;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
  overflow: hidden;
  cursor: pointer;
}

.gallery-grid img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

@media (max-width: 680px) {
  .editor-toolbar {
    gap: 4px;
  }

  .editor-surface {
    min-height: 300px;
    padding: 18px 14px;
  }

  .gallery-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
