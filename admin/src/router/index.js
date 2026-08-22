import { createRouter, createWebHashHistory } from 'vue-router'
import { getToken } from '../utils/auth'
import Layout from '../components/Layout.vue'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/login/Login.vue')
  },
  {
    path: '/',
    component: Layout,
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/dashboard/Dashboard.vue')
      },
      {
        path: 'orders',
        name: 'OrderList',
        component: () => import('../views/orders/OrderList.vue')
      },
      {
        path: 'orders/:id',
        name: 'OrderDetail',
        component: () => import('../views/orders/OrderDetail.vue')
      },
      {
        path: 'devices',
        name: 'DeviceList',
        component: () => import('../views/devices/DeviceList.vue')
      },
      {
        path: 'users',
        name: 'UserList',
        component: () => import('../views/users/UserList.vue')
      },
      {
        path: 'repairs',
        name: 'RepairList',
        component: () => import('../views/repairs/RepairList.vue')
      },
      {
        path: 'coupons',
        name: 'CouponManage',
        component: () => import('../views/coupons/CouponManage.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to) => {
  if (to.path !== '/login' && !getToken()) {
    return '/login'
  }
})

export default router
