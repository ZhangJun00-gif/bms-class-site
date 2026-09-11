import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setUnauthorizedHandler } from './lib/api';
import { sanitizeRedirect } from './lib/redirect';
import { useAuthStore } from './stores/auth';
import './styles/main.css';

const pinia = createPinia();

setUnauthorizedHandler(() => {
  const auth = useAuthStore(pinia);
  const wasAuthenticated = auth.isAuthenticated;
  auth.expireSession();
  if (!wasAuthenticated || router.currentRoute.value.path === '/login') return;
  const redirect = sanitizeRedirect(router.currentRoute.value.fullPath);
  void router.replace({
    path: '/login',
    query: redirect === '/' ? {} : { redirect },
  });
});

createApp(App).use(pinia).use(router).mount('#app');
