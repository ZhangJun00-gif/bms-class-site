<script setup lang="ts">
import SiteHeader from './components/layout/SiteHeader.vue';
import SiteFooter from './components/layout/SiteFooter.vue';
import ToastRegion from './components/common/ToastRegion.vue';
import ConfirmDialog from './components/common/ConfirmDialog.vue';
import AnnouncementGate from './components/announcements/AnnouncementGate.vue';
</script>

<template>
  <div class="app-shell">
    <SiteHeader />
    <RouterView />
    <SiteFooter />
    <ToastRegion />
    <ConfirmDialog />
    <AnnouncementGate />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
</style>
