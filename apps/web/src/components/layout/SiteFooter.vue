<script setup lang="ts">
const year = new Date().getFullYear();

const links = [
  { to: '/news', label: '班级动态' },
  { to: '/knowledge', label: '知识库' },
  { to: '/quiz', label: '题库' },
  { to: '/albums', label: '班级相册' },
  { to: '/forum', label: '班级论坛' },
];
</script>

<template>
  <footer class="site-footer">
    <!-- ECG 脉搏线：位于页脚上边界与内容区之间的正中，上下留白相等 -->
    <div class="ecg-strip" aria-hidden="true">
      <svg viewBox="0 0 1200 48" preserveAspectRatio="none">
        <path
          class="ecg-base"
          d="M0,24 L180,24 L196,24 L206,8 L218,40 L230,14 L240,24 L420,24 L436,24 L446,8 L458,40 L470,14 L480,24 L660,24 L676,24 L686,8 L698,40 L710,14 L720,24 L900,24 L916,24 L926,8 L938,40 L950,14 L960,24 L1200,24"
        />
        <path
          class="ecg-pulse"
          d="M0,24 L180,24 L196,24 L206,8 L218,40 L230,14 L240,24 L420,24 L436,24 L446,8 L458,40 L470,14 L480,24 L660,24 L676,24 L686,8 L698,40 L710,14 L720,24 L900,24 L916,24 L926,8 L938,40 L950,14 L960,24 L1200,24"
        />
      </svg>
    </div>

    <div class="footer-inner">
      <div class="footer-brand">
        <img src="/badge.png" alt="" width="46" height="46" aria-hidden="true" />
        <div class="footer-brand-text">
          <p class="footer-name">班级网站</p>
          <p class="footer-motto">共同学习，共同成长</p>
        </div>
      </div>

      <nav class="footer-nav" aria-label="页脚导航">
        <RouterLink v-for="link in links" :key="link.to" :to="link.to">{{ link.label }}</RouterLink>
      </nav>

      <p class="footer-org">OUR CLASS · LEARN TOGETHER</p>
    </div>

    <div class="footer-bar">
      <span>© {{ year }} 班级网站 · Class Community</span>
      <span class="footer-cross" aria-hidden="true">✚</span>
      <span>仅供班级成员内部交流使用</span>
    </div>
  </footer>
</template>

<style scoped>
.site-footer {
  margin-top: auto;
  background: var(--gradient-deep);
  color: rgba(232, 238, 252, 0.82);
}

/* ECG 位于页脚上边界与内容区之间的正中：上下 padding 相等，
   内容区不再保留顶部 padding，间距由本条纹理带统一提供。
   用 padding 而非 margin，避免与页脚发生外边距折叠 */
.ecg-strip {
  padding: var(--space-8) 0;
  overflow: hidden;
  opacity: 0.9;
  /* 两端渐隐，避免脉搏线硬切到屏幕边缘 */
  mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
}

.ecg-strip svg {
  width: 100%;
  height: 44px;
  display: block;
}

.ecg-base,
.ecg-pulse {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ecg-base {
  stroke: rgba(18, 165, 179, 0.22);
  stroke-width: 1.5;
}

/* 一道亮青脉搏沿基线循环扫过 */
.ecg-pulse {
  stroke: var(--accent-vivid);
  stroke-width: 2;
  stroke-dasharray: 90 1110;
  animation: ecg-sweep 4.8s linear infinite;
}

@keyframes ecg-sweep {
  from {
    stroke-dashoffset: 1200;
  }

  to {
    stroke-dashoffset: 0;
  }
}

.footer-inner {
  width: min(var(--content-max), calc(100% - 48px));
  margin: 0 auto;
  padding: 0 0 var(--space-6);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-8);
  flex-wrap: wrap;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.footer-brand img {
  width: 46px;
  height: 46px;
  border-radius: var(--radius-m);
  background: rgba(255, 255, 255, 0.94);
  padding: 4px;
  object-fit: contain;
}

.footer-name {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: 0.08em;
  color: #f2f5fd;
}

.footer-motto {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 0.22em;
  color: rgba(18, 165, 179, 0.85);
}

.footer-nav {
  display: flex;
  gap: var(--space-5);
  flex-wrap: wrap;
}

.footer-nav a {
  color: rgba(232, 238, 252, 0.66);
  font-size: 13px;
  text-decoration: none;
  transition: color 0.16s var(--ease-out);
}

.footer-nav a:hover {
  color: #ffffff;
  text-decoration: none;
}

.footer-org {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(232, 238, 252, 0.4);
}

.footer-bar {
  width: min(var(--content-max), calc(100% - 48px));
  margin: 0 auto;
  padding: var(--space-4) 0 var(--space-5);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  border-top: 1px solid rgba(232, 238, 252, 0.12);
  font-size: 12px;
  color: rgba(232, 238, 252, 0.42);
}

.footer-cross {
  color: var(--accent-vivid);
  font-size: 13px;
}

@media (max-width: 560px) {
  .ecg-strip {
    padding: var(--space-5) 0;
  }

  .ecg-strip svg {
    height: 36px;
  }

  .footer-inner {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-6);
    padding: 0 0 var(--space-5);
  }

  .footer-bar {
    font-size: 11px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ecg-pulse {
    animation: none;
  }
}
</style>
