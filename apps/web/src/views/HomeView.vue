<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowRight, ArrowUpRight, ChevronDown, ListChecks } from 'lucide-vue-next';
import ParticleCanvas from '../components/home/ParticleCanvas.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import NewsDetailDialog from '../components/news/NewsDetailDialog.vue';
import { useAsyncState } from '../composables/useAsyncState';
import { fetchNewsSummaries } from '../lib/news';
import { formatDate } from '../lib/formatters';
import type { NewsSummary } from '../types';

// 只取 3 条公开摘要，正文在用户点击后由详情弹窗按需加载
const { data, loading, error, reload } = useAsyncState(async () => {
  const result = await fetchNewsSummaries(false, 1, 3);
  return result.items;
});
const items = computed(() => data.value ?? []);

const selected = ref<NewsSummary | null>(null);
</script>

<template>
  <main>
    <section class="hero" aria-label="班级首页横幅">
      <ParticleCanvas />
      <div class="hero-copy">
        <p class="eyebrow">
          <span class="eyebrow-rule" aria-hidden="true" />
          OUR CLASS · LEARN TOGETHER
        </p>
        <h1>班级网站</h1>
        <p class="hero-subtitle">CLASS COMMUNITY</p>
        <svg class="hero-ecg" viewBox="0 0 240 32" aria-hidden="true">
          <path d="M0,16 L72,16 L84,16 L92,4 L102,28 L112,9 L120,16 L240,16" />
        </svg>
        <p class="hero-description">共同学习，共同成长。这里记录共同成长，也沉淀值得反复查阅的知识与讨论。</p>
        <div class="hero-actions">
          <RouterLink class="button" to="/news">
            查看班级动态
            <ArrowRight :size="17" aria-hidden="true" />
          </RouterLink>
          <RouterLink class="button secondary" to="/daily">
            <ListChecks :size="17" aria-hidden="true" />
            今日练习
          </RouterLink>
        </div>
      </div>
      <p class="hero-index" aria-hidden="true">OUR CLASS ARCHIVE</p>
      <a class="scroll-hint" href="#home-news" aria-label="向下滚动查看近期动态">
        <span>近期动态</span>
        <ChevronDown :size="18" aria-hidden="true" />
      </a>
    </section>

    <section id="home-news" class="home-news" aria-label="近期动态">
      <div class="news-inner">
        <div class="section-heading">
          <div class="section-heading-text">
            <p class="section-kicker">Recent · 班级通讯</p>
            <h2>近期动态</h2>
          </div>
          <RouterLink class="section-more" to="/news">
            查看全部
            <ArrowUpRight :size="16" aria-hidden="true" />
          </RouterLink>
        </div>
        <div v-if="loading" class="news-grid">
          <div v-for="index in 3" :key="index" class="card">
            <SkeletonBlock :lines="3" />
          </div>
        </div>
        <ErrorState v-else-if="error" :message="error" @retry="reload" />
        <EmptyState v-else-if="!items.length" title="暂无公开动态" hint="班级动态发布后会显示在这里" />
        <div v-else class="news-grid">
          <article
            v-for="(item, index) in items"
            :key="item.id"
            class="news-card"
            role="button"
            tabindex="0"
            :aria-label="`阅读全文：${item.title}`"
            @click="selected = item"
            @keydown.enter.prevent="selected = item"
            @keydown.space.prevent="selected = item"
          >
            <span class="news-card-index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
            <h3>{{ item.title }}</h3>
            <p class="clamp-2">{{ item.summary }}</p>
            <time class="meta" :datetime="item.publishedAt ?? undefined">{{ formatDate(item.publishedAt) }}</time>
            <span class="news-card-more" aria-hidden="true">阅读全文</span>
          </article>
        </div>
      </div>
    </section>

    <NewsDetailDialog :item="selected" @close="selected = null" />
  </main>
</template>

<style scoped>
.hero {
  position: relative;
  display: flex;
  align-items: center;
  min-height: calc(100svh - var(--header-height));
  overflow: hidden;
  background: var(--gradient-hero);
}

/* 低透明医学十字纹理，呼应临床主题而不干扰粒子班徽 */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(38, 57, 125, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(38, 57, 125, 0.05) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(ellipse 90% 80% at 30% 40%, rgba(0, 0, 0, 0.7), transparent 70%);
  -webkit-mask-image: radial-gradient(ellipse 90% 80% at 30% 40%, rgba(0, 0, 0, 0.7), transparent 70%);
}

.hero-copy {
  position: relative;
  z-index: 1;
  width: min(600px, 84vw);
  margin-left: max(24px, 8vw);
  padding: var(--space-16) 0;
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 0 var(--space-5);
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.eyebrow-rule {
  width: 34px;
  height: 2px;
  flex: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-accent);
}

.hero h1 {
  margin: 0;
  color: var(--primary-dark);
  font-size: 64px;
  font-weight: 250;
  letter-spacing: 0.1em;
  line-height: 1.15;
}

.hero-subtitle {
  margin: var(--space-3) 0 0;
  color: var(--muted);
  font-size: 13px;
  letter-spacing: 0.4em;
}

.hero-ecg {
  display: block;
  width: 220px;
  height: 30px;
  margin-top: var(--space-5);
}

.hero-ecg path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.75;
}

.hero-description {
  margin: var(--space-6) 0 0;
  max-width: 460px;
  color: var(--ink-soft);
  line-height: 2;
}

.hero-actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-8);
}

/* 竖排刊号，后现代编辑排版点缀 */
.hero-index {
  position: absolute;
  right: max(20px, 3.5vw);
  bottom: var(--space-16);
  z-index: 1;
  margin: 0;
  writing-mode: vertical-rl;
  color: rgba(38, 57, 125, 0.38);
  font-size: 11px;
  letter-spacing: 0.34em;
}

.scroll-hint {
  position: absolute;
  left: 50%;
  bottom: var(--space-5);
  z-index: 1;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.2em;
  text-decoration: none;
}

.scroll-hint:hover {
  color: var(--accent-dark);
  text-decoration: none;
}

.scroll-hint svg {
  animation: scroll-dip 1.6s ease-in-out infinite;
}

@keyframes scroll-dip {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(4px);
  }
}

.home-news {
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.news-inner {
  width: min(var(--content-max), calc(100% - 48px));
  margin: 0 auto;
  padding: var(--space-12) 0 var(--space-16);
}

.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--space-5);
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.section-kicker {
  margin: 0 0 var(--space-1);
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.section-heading h2 {
  margin: 0;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.section-more {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--accent-dark);
  font-size: 14px;
  font-weight: 550;
  text-decoration: none;
  white-space: nowrap;
}

.section-more:hover {
  color: var(--accent);
  text-decoration: none;
}

.news-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-5);
}

/* 期刊卡片：编号 + 悬停抬升 + 顶部渐变发线；整卡可点击打开全文 */
.news-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-6);
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-s);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out), border-color 0.2s var(--ease-out);
}

.news-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--gradient-hairline);
  opacity: 0;
  transition: opacity 0.2s var(--ease-out);
}

.news-card:hover {
  transform: translateY(-3px);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lift);
}

.news-card:hover::before {
  opacity: 1;
}

.news-card-index {
  color: rgba(15, 138, 150, 0.5);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.18em;
}

.news-card h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.news-card p {
  margin: 0;
  color: var(--muted);
  line-height: 1.75;
}

/* 「阅读全文」提示固定在卡片底部，等高一行的卡片之间对齐 */
.news-card-more {
  margin-top: auto;
  color: var(--accent-dark);
  font-size: 13px;
  font-weight: 550;
}

.news-card:hover .news-card-more,
.news-card:focus-visible .news-card-more {
  text-decoration: underline;
}

@media (max-width: 900px) {
  .hero {
    align-items: flex-start;
  }

  .hero-copy {
    width: calc(100% - 48px);
    margin: 0 24px;
    padding-top: 12vh;
  }

  .hero h1 {
    font-size: 42px;
  }

  .hero-index {
    display: none;
  }

  .news-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .hero-actions .button {
    flex: 1;
  }

  .hero-ecg {
    width: 180px;
  }

  .news-inner {
    width: calc(100% - 36px);
    padding: var(--space-10) 0 var(--space-12);
  }

  .section-heading h2 {
    font-size: 24px;
  }
}
</style>
