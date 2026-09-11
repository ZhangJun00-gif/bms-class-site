<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { LogIn, Megaphone, Menu, ShieldCheck, X } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useAnnouncementsStore } from '../../stores/announcements';
import { lockScroll, unlockScroll } from '../../composables/useScrollLock';
import MemberMenu from './MemberMenu.vue';

const auth = useAuthStore();
const notices = useAnnouncementsStore();
const route = useRoute();
const open = ref(false);
const toggleButton = ref<HTMLButtonElement>();
let locked = false;

const links = [
  { to: '/news', label: '班级动态', auth: false },
  { to: '/albums', label: '班级相册', auth: true },
  { to: '/forum', label: '班级论坛', auth: true },
  { to: '/daily', label: '每日一练', auth: true },
  { to: '/credit-hours', label: '学时统计', auth: true },
  { to: '/knowledge', label: '知识库', auth: true },
  { to: '/quiz', label: '题库', auth: true },
];

watch(open, (value) => {
  if (value) {
    lockScroll();
    locked = true;
    document.addEventListener('keydown', onKeydown);
  } else {
    release();
  }
});

/** 路由变化后自动关闭移动导航 */
watch(
  () => route.fullPath,
  () => {
    open.value = false;
  },
);

/** 与样式断点一致：视口变宽后菜单与开关都被隐藏，必须强制关闭以免残留锁滚动 */
let mobileQuery: MediaQueryList | null = null;

onMounted(() => {
  if (typeof window.matchMedia !== 'function') return;
  mobileQuery = window.matchMedia('(max-width: 900px)');
  mobileQuery.addEventListener('change', onBreakpointChange);
});

onBeforeUnmount(() => {
  mobileQuery?.removeEventListener('change', onBreakpointChange);
  release();
});

function onBreakpointChange(event: MediaQueryListEvent) {
  if (!event.matches) open.value = false;
}

function release() {
  if (locked) {
    unlockScroll();
    locked = false;
  }
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    open.value = false;
    // 菜单被 v-if 移除后焦点会掉到 body，主动还给切换按钮
    toggleButton.value?.focus();
  }
}
</script>

<template>
  <header class="site-header">
    <RouterLink class="brand" to="/">
      <span class="brand-badge">
        <img src="/badge.png" alt="班级网站班徽" width="40" height="40" />
      </span>
      <span class="brand-name">班级<em>网站</em></span>
    </RouterLink>

    <nav class="desktop-nav" aria-label="主导航">
      <template v-for="link in links" :key="link.to">
        <RouterLink v-if="!link.auth || auth.isAuthenticated" :to="link.to">{{ link.label }}</RouterLink>
      </template>
      <RouterLink v-if="auth.canEdit" to="/admin" class="admin-link">
        <ShieldCheck :size="15" aria-hidden="true" />
        管理
      </RouterLink>
    </nav>

    <div class="header-side">
      <RouterLink v-if="auth.isAuthenticated" to="/announcements" class="icon-button announcement-link" title="公告" aria-label="公告"><Megaphone :size="19" aria-hidden="true" /><span v-if="notices.unread" class="unread-dot" aria-label="有未确认公告" /></RouterLink>
      <MemberMenu v-if="auth.isAuthenticated" />
      <RouterLink v-else to="/login" class="login-link">
        <LogIn :size="16" aria-hidden="true" />
        登录
      </RouterLink>
      <button
        ref="toggleButton"
        type="button"
        class="icon-button mobile-toggle"
        :aria-label="open ? '关闭导航菜单' : '打开导航菜单'"
        :aria-expanded="open"
        aria-controls="mobile-nav"
        @click="open = !open"
      >
        <X v-if="open" :size="20" aria-hidden="true" />
        <Menu v-else :size="20" aria-hidden="true" />
      </button>
    </div>

    <nav v-if="open" id="mobile-nav" class="mobile-nav" aria-label="移动端导航">
      <template v-for="link in links" :key="link.to">
        <RouterLink v-if="!link.auth || auth.isAuthenticated" :to="link.to">{{ link.label }}</RouterLink>
      </template>
      <RouterLink v-if="auth.canEdit" to="/admin" class="admin-link">
        <ShieldCheck :size="16" aria-hidden="true" />
        管理后台
      </RouterLink>
    </nav>
  </header>
</template>

<style scoped>
.site-header {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  height: var(--header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 0 max(24px, 5vw);
  background: rgba(248, 251, 254, 0.82);
  backdrop-filter: blur(18px) saturate(1.5);
  -webkit-backdrop-filter: blur(18px) saturate(1.5);
}

/* 底部 1px 渐变发线替代生硬边框 */
.site-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-strong) 18%, var(--border-strong) 82%, transparent);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--primary-dark);
  font-weight: 650;
  letter-spacing: 0.02em;
  text-decoration: none;
  white-space: nowrap;
}

.brand-badge {
  width: 42px;
  height: 42px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-s);
  transition: transform 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out);
}

.brand:hover .brand-badge {
  transform: translateY(-1px);
  box-shadow: var(--shadow-m);
}

.brand-badge img {
  width: 34px;
  height: 34px;
  object-fit: contain;
}

.brand em {
  color: var(--accent);
  font-style: normal;
}

.desktop-nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

.desktop-nav a {
  position: relative;
  color: var(--muted);
  font-size: 14px;
  padding: 8px 14px;
  border-radius: var(--radius-pill);
  text-decoration: none;
  transition: color 0.16s var(--ease-out), background 0.16s var(--ease-out);
}

.desktop-nav a:hover {
  color: var(--primary-dark);
  background: var(--surface-muted);
}

.desktop-nav a.router-link-active {
  color: var(--accent-dark);
  background: var(--accent-soft);
  font-weight: 550;
}

.admin-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.header-side {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.announcement-link { position: relative; flex: none; width: 40px; height: 40px; text-decoration: none; }
.unread-dot { position: absolute; right: 6px; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }

.login-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 18px;
  border: 1px solid var(--primary);
  border-radius: var(--radius-pill);
  color: var(--primary);
  font-size: 14px;
  font-weight: 550;
  text-decoration: none;
  transition: background 0.18s var(--ease-out), color 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out);
}

.login-link:hover {
  background: var(--gradient-primary);
  color: #ffffff;
  box-shadow: 0 10px 20px -8px rgba(20, 31, 75, 0.45);
}

.mobile-toggle {
  display: none;
}

.mobile-nav {
  display: none;
}

@media (max-width: 900px) {
  .desktop-nav {
    display: none;
  }

  .mobile-toggle {
    display: inline-grid;
  }

  .mobile-nav {
    position: fixed;
    top: var(--header-height);
    left: 0;
    right: 0;
    /* 不用 bottom:0——header 的 backdrop-filter 会成为 fixed 包含块 */
    height: calc(100vh - var(--header-height));
    height: calc(100dvh - var(--header-height));
    display: flex;
    flex-direction: column;
    padding: var(--space-3) 24px var(--space-6);
    background: rgba(255, 255, 255, 0.97);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    overflow-y: auto;
  }

  .mobile-nav a {
    display: flex;
    align-items: center;
    min-height: 50px;
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--border);
    border-radius: var(--radius-s);
    color: var(--ink-soft);
    font-size: 15px;
    text-decoration: none;
  }

  .mobile-nav a.router-link-active {
    color: var(--accent-dark);
    background: var(--accent-soft);
    border-bottom-color: transparent;
    font-weight: 600;
  }
}

@media (max-width: 560px) {
  .site-header {
    padding: 0 12px;
    gap: 8px;
  }
  .header-side { min-width: 0; gap: 5px; }
  .brand { gap: 8px; }
  .header-side :deep(.member-trigger) { max-width: 90px; padding-inline: 7px; }
  .mobile-toggle { flex: none; }

  .brand-name {
    font-size: 15px;
  }

  .brand-badge {
    width: 38px;
    height: 38px;
  }

  .brand-badge img {
    width: 30px;
    height: 30px;
  }
}
</style>
