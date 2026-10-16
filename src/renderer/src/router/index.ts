import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  linkActiveClass: 'active',
  routes: [
    {
      path: '/',
      name: 'typer',
      component: () => import('@renderer/views/TyperView.vue'),
      meta: { title: '输入' }
    },
    {
      path: '/logs',
      name: 'logs',
      component: () => import('@renderer/views/LogsView.vue'),
      meta: { title: '日志' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@renderer/views/SettingsView.vue'),
      meta: { title: '设置' }
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@renderer/views/AboutView.vue'),
      meta: { title: '关于' }
    },
    // 未知路径回到输入页，避免出现空白窗口
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router
