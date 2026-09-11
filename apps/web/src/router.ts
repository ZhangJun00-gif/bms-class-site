import { createRouter, createWebHistory } from 'vue-router';
import { sanitizeRedirect } from './lib/redirect';
import { useAuthStore } from './stores/auth';

const routes = [
  {
    path: '/',
    component: () => import('./views/HomeView.vue'),
    meta: { title: '首页' },
  },
  {
    path: '/login',
    component: () => import('./views/LoginView.vue'),
    meta: { guest: true, title: '成员入口' },
  },
  {
    path: '/news',
    component: () => import('./views/NewsView.vue'),
    meta: { title: '班级动态' },
  },
  {
    path: '/announcements',
    component: () => import('./views/AnnouncementsView.vue'),
    meta: { auth: true, title: '公告' },
  },
  {
    path: '/albums',
    component: () => import('./views/AlbumsView.vue'),
    meta: { auth: true, title: '班级相册' },
  },
  {
    path: '/forum',
    component: () => import('./views/ForumView.vue'),
    meta: { auth: true, title: '班级论坛' },
  },
  {
    path: '/knowledge',
    component: () => import('./views/KnowledgeView.vue'),
    meta: { auth: true, title: '知识库与 AI' },
  },
  {
    path: '/quiz',
    component: () => import('./views/QuizView.vue'),
    meta: { auth: true, title: '题库' },
  },
  {
    path: '/daily',
    component: () => import('./views/DailyPracticeView.vue'),
    meta: { auth: true, title: '每日一练' },
  },
  {
    path: '/credit-hours',
    component: () => import('./views/CreditHoursView.vue'),
    meta: { auth: true, title: '学时统计' },
  },
  {
    path: '/admin',
    component: () => import('./views/AdminView.vue'),
    meta: { editor: true, title: '管理后台' },
  },
  {
    path: '/:pathMatch(.*)*',
    component: () => import('./views/NotFoundView.vue'),
    meta: { title: '页面不存在' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, from, savedPosition) => {
    if (savedPosition) return savedPosition;
    if (to.path === from.path) return false;
    return { top: 0 };
  },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) {
    try {
      await auth.bootstrap();
    } catch {
      if (to.meta.auth || to.meta.editor) {
        return {
          path: '/login',
          query: { redirect: sanitizeRedirect(to.fullPath), unavailable: '1' },
        };
      }
    }
  }
  if (to.meta.auth && !auth.isAuthenticated)
    return { path: '/login', query: { redirect: to.fullPath } };
  if (to.meta.editor && !auth.canEdit) return '/';
  if (to.meta.guest && auth.isAuthenticated) return '/';
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title
    ? `${to.meta.title} · 班级网站`
    : '班级网站';
});

export default router;
