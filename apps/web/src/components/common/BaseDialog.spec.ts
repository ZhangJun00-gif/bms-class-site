import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import BaseDialog from './BaseDialog.vue';

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

async function mountOpenDialog(title: string) {
  const wrapper = mount(BaseDialog, {
    props: { open: false, title },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

describe('BaseDialog focus restoration', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns focus to the trigger element after closing', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const wrapper = await mountOpenDialog('详情');
    expect(document.activeElement).not.toBe(trigger);

    await wrapper.setProps({ open: false });
    expect(document.activeElement).toBe(trigger);

    wrapper.unmount();
  });

  it('restores focus when the dialog is unmounted while open', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const wrapper = await mountOpenDialog('详情');

    wrapper.unmount();
    expect(document.activeElement).toBe(trigger);
  });

  it('skips focus restoration when the trigger left the document', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const wrapper = await mountOpenDialog('详情');

    trigger.remove();
    await wrapper.setProps({ open: false });
    expect(document.activeElement).not.toBe(trigger);

    wrapper.unmount();
  });
});

describe('BaseDialog stacked Escape handling', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes only the top dialog when dialogs are stacked', async () => {
    const lower = await mountOpenDialog('下层');
    const upper = await mountOpenDialog('上层');

    pressEscape();
    expect(lower.emitted('close')).toBeUndefined();
    expect(upper.emitted('close')).toHaveLength(1);

    // 父级响应 close 关闭上层后，下一次 ESC 才轮到下层
    await upper.setProps({ open: false });
    pressEscape();
    expect(lower.emitted('close')).toHaveLength(1);

    lower.unmount();
    upper.unmount();
  });

  it('removes an unmounted dialog from the stack', async () => {
    const lower = await mountOpenDialog('下层');
    const upper = await mountOpenDialog('上层');

    upper.unmount();
    pressEscape();
    expect(lower.emitted('close')).toHaveLength(1);

    lower.unmount();
  });
});

describe('mandatory announcement dialog boundary', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('keeps mandatory content on top of later ordinary dialogs and rejects escape, backdrop, and focus bypass', async () => {
    const background = document.createElement('button');
    document.body.append(background);
    const mandatory = mount(BaseDialog, {
      props: { open: true, title: '必须确认的公告', dismissable: false, priority: 100 },
      attachTo: document.body,
    });
    await flushPromises();
    const mandatoryPanel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const mandatoryOverlay = mandatoryPanel.parentElement!;
    const ordinary = await mountOpenDialog('其他弹窗');
    await flushPromises();
    expect(background.hasAttribute('inert')).toBe(true);
    expect(mandatoryOverlay.hasAttribute('inert')).toBe(false);
    expect(document.querySelectorAll('.dialog-overlay')[1]!.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(mandatoryPanel);
    pressEscape();
    mandatoryOverlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    background.focus();
    expect(document.activeElement).toBe(mandatoryPanel);
    expect(mandatory.emitted('close')).toBeUndefined();
    expect(ordinary.emitted('close')).toBeUndefined();
    expect(mandatoryOverlay.querySelector('[aria-label="关闭对话框"]')).toBeNull();
    ordinary.unmount();
    mandatory.unmount();
    expect(background.hasAttribute('inert')).toBe(false);
  });

  it('makes newly inserted background content inert and preserves pre-existing inert state on close', async () => {
    const originallyInert = document.createElement('section');
    originallyInert.setAttribute('inert', '');
    document.body.append(originallyInert);
    const dialog = await mountOpenDialog('公告');
    const appended = document.createElement('button');
    document.body.append(appended);
    await flushPromises();
    expect(appended.hasAttribute('inert')).toBe(true);
    await dialog.setProps({ open: false });
    expect(appended.hasAttribute('inert')).toBe(false);
    expect(originallyInert.hasAttribute('inert')).toBe(true);
    dialog.unmount();
  });
});
