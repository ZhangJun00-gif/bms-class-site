<template>
  <main class="page">
    <section class="form-shell">
      <p class="notfound-code" aria-hidden="true">404</p>
      <h1>页面不存在</h1>
      <p>这个地址没有对应内容，可能已经移动或删除。</p>
      <RouterLink class="button" to="/">返回首页</RouterLink>
    </section>
  </main>
</template>

<style scoped>
.notfound-code {
  margin: 0 0 var(--space-2);
  font-size: 64px;
  font-weight: 250;
  letter-spacing: 0.12em;
  line-height: 1;
  color: rgba(38, 57, 125, 0.22);
}
</style>
