import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RichTextEditor from './RichTextEditor.vue';

class FakeXmlHttpRequest {
  static instances: FakeXmlHttpRequest[] = [];
  status = 0;
  response: unknown = null;
  responseType = '';
  withCredentials = false;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXmlHttpRequest.instances.push(this);
  }

  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.onabort?.();
  }
}

function photo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'photo-1',
    albumId: null,
    caption: '',
    mimeType: 'image/webp',
    size: 1000,
    width: 800,
    height: 600,
    sortOrder: 0,
    createdAt: '2026-07-20T00:00:00.000Z',
    url: '/api/v1/media/images/photo-1/content',
    ...overrides,
  };
}

function mountEditor() {
  return mount(RichTextEditor, { props: { modelValue: '' } });
}

async function pickFiles(wrapper: ReturnType<typeof mountEditor>, files: File[]) {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', {
    value: files,
    configurable: true,
  });
  await input.trigger('change');
}

function insertHtmlCalls() {
  return vi
    .mocked(document.execCommand)
    .mock.calls.filter((call) => call[0] === 'insertHTML')
    .map((call) => String(call[2]));
}

describe('RichTextEditor image uploads', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    document.execCommand = vi.fn().mockReturnValue(true) as never;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeXmlHttpRequest.instances = [];
  });

  it('uploads multiple images one by one and reports partial success precisely', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    await pickFiles(wrapper, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    await flushPromises();

    // 第一张：进度与逐项状态
    const first = FakeXmlHttpRequest.instances[0]!;
    first.upload.onprogress?.({
      loaded: 50,
      total: 100,
      lengthComputable: true,
    } as ProgressEvent);
    await flushPromises();
    expect(wrapper.get('.upload-list').text()).toContain('a.png');
    expect(wrapper.get('.upload-list').text()).toContain('50%');

    first.status = 201;
    first.response = photo({ caption: '春游合影' });
    first.onload?.();
    await flushPromises();

    // 第二张失败：前面成功的保留，错误说明成功数量与失败文件
    const second = FakeXmlHttpRequest.instances[1]!;
    expect(second).toBeTruthy();
    second.status = 500;
    second.response = { message: '服务异常' };
    second.onload?.();
    await flushPromises();

    const listText = wrapper.get('.upload-list').text();
    expect(listText).toContain('已插入');
    expect(listText).toContain('失败：服务异常');
    const notice = wrapper.get('.editor-notice');
    expect(notice.text()).toContain('已插入 1 张');
    expect(notice.text()).toContain('「b.png」上传失败');

    // 成功插入的 figure 保留在正文中
    const inserted = insertHtmlCalls();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain('data-photo-id="photo-1"');
  });

  it('cancels only the current upload and keeps already inserted images', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    await pickFiles(wrapper, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    await flushPromises();

    const first = FakeXmlHttpRequest.instances[0]!;
    first.status = 201;
    first.response = photo();
    first.onload?.();
    await flushPromises();
    expect(insertHtmlCalls()).toHaveLength(1);

    // 第二张上传中：取消按钮只中断当前上传
    const cancel = wrapper
      .findAll('.upload-action')
      .find((button) => button.text() === '取消')!;
    await cancel.trigger('click');
    await flushPromises();

    const listText = wrapper.get('.upload-list').text();
    expect(listText).toContain('已取消');
    const notice = wrapper.get('.editor-notice');
    expect(notice.text()).toContain('已取消上传');
    expect(notice.text()).toContain('已保留成功插入的 1 张图片');
    // 不新增插入，也不清空已插入内容
    expect(insertHtmlCalls()).toHaveLength(1);
  });

  it('generates a visible figcaption and escapes HTML attributes', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    await pickFiles(wrapper, [
      new File(['a'], 'a"on<x>.png', { type: 'image/png' }),
    ]);
    await flushPromises();

    const request = FakeXmlHttpRequest.instances[0]!;
    request.status = 201;
    request.response = photo({
      caption: '合影 "A" <班>',
      url: '/api/v1/media/images/p1/content?x=1&y=2"',
    });
    request.onload?.();
    await flushPromises();

    const [html] = insertHtmlCalls();
    expect(html).toContain('<figcaption>合影 &quot;A&quot; &lt;班&gt;</figcaption>');
    expect(html).toContain('src="/api/v1/media/images/p1/content?x=1&amp;y=2&quot;"');
    expect(html).toContain('alt="a&quot;on&lt;x&gt;.png"');
    expect(html).not.toContain('<班>');
  });

  it('omits figcaption when the upload has no caption', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    await pickFiles(wrapper, [new File(['a'], 'a.png', { type: 'image/png' })]);
    await flushPromises();

    const request = FakeXmlHttpRequest.instances[0]!;
    request.status = 201;
    request.response = photo({ caption: '' });
    request.onload?.();
    await flushPromises();

    const [html] = insertHtmlCalls();
    expect(html).toContain('<figure><img');
    expect(html).not.toContain('figcaption');
    expect(wrapper.get('.editor-notice').text()).toContain('图片已插入正文');
  });

  it('rejects unsupported file types before any request', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    await pickFiles(wrapper, [
      new File(['a'], 'notes.txt', { type: 'text/plain' }),
    ]);
    await flushPromises();

    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
    expect(wrapper.get('.editor-notice').text()).toContain('格式不支持');
  });

  it('aborts the in-flight upload on unmount and never emits empty content', async () => {
    const wrapper = mount(RichTextEditor, {
      props: { modelValue: '<p>初始正文</p>' },
    });
    await flushPromises();
    await pickFiles(wrapper, [new File(['a'], 'a.png', { type: 'image/png' })]);
    await flushPromises();

    const first = FakeXmlHttpRequest.instances[0]!;
    const abortSpy = vi.spyOn(first, 'abort');
    wrapper.unmount();
    await flushPromises();

    expect(abortSpy).toHaveBeenCalled();
    expect(insertHtmlCalls()).toHaveLength(0);
    const emitted = wrapper.emitted('update:modelValue') ?? [];
    expect(emitted.flat()).not.toContain('');
  });

  it('skips the stale insertion when the form content was reset during upload', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    await pickFiles(wrapper, [new File(['a'], 'a.png', { type: 'image/png' })]);
    await flushPromises();

    // 上传在途时切换到另一条记录：父级重写正文内容
    await wrapper.setProps({ modelValue: '<p>另一条记录的正文</p>' });
    const first = FakeXmlHttpRequest.instances[0]!;
    first.status = 201;
    first.response = photo();
    first.onload?.();
    await flushPromises();

    // 迟到的上传不得插入旧图片，该项标记为已取消
    expect(insertHtmlCalls()).toHaveLength(0);
    expect(wrapper.get('.upload-list').text()).toContain('已取消');
  });
});
