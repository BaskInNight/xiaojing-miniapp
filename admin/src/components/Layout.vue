<template>
  <el-container class="layout-container">
    <el-aside :width="isCollapse ? '64px' : '220px'">
      <div class="logo">
        <span v-if="!isCollapse">净界同频 · 管理</span>
        <span v-else>净</span>
      </div>
      <el-menu
        :default-active="route.path"
        :collapse="isCollapse"
        background-color="#fff"
        text-color="#333"
        active-text-color="#409eff"
        router
      >
        <el-menu-item index="/dashboard">
          <el-icon><DataAnalysis /></el-icon>
          <span>仪表盘</span>
        </el-menu-item>
        <el-menu-item index="/orders">
          <el-icon><List /></el-icon>
          <span>订单管理</span>
        </el-menu-item>
        <el-menu-item index="/devices">
          <el-icon><Monitor /></el-icon>
          <span>设备管理</span>
        </el-menu-item>
        <el-menu-item index="/users">
          <el-icon><User /></el-icon>
          <span>用户管理</span>
        </el-menu-item>
        <el-menu-item index="/repairs">
          <el-icon><WarningFilled /></el-icon>
          <span>
            报修工单
            <el-tag v-if="pendingRepairCount > 0" type="danger" size="small" style="margin-left:8px; animation: pulse 1.5s infinite;">
              {{ pendingRepairCount }}
            </el-tag>
          </span>
        </el-menu-item>
        <el-menu-item index="/coupons">
          <el-icon><Ticket /></el-icon>
          <span>优惠券管理</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header>
        <div class="header-left">
          <el-icon class="collapse-btn" @click="isCollapse = !isCollapse">
            <Fold v-if="!isCollapse" /><Expand v-else />
          </el-icon>
          <el-breadcrumb>
            <el-breadcrumb-item :to="{ path: '/dashboard' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="route.meta.title">{{ route.meta.title }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <span class="username">{{ username }}</span>
          <el-button type="danger" size="small" @click="handleLogout">退出</el-button>
        </div>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getUser, clearToken } from '../utils/auth'
import { callAction } from '../utils/request'
import { ElNotification } from 'element-plus'

const route = useRoute()
const router = useRouter()
const isCollapse = ref(false)
const username = ref((getUser() && getUser().username) || '管理员')
const pendingRepairCount = ref(0)
const lastCount = ref(0)  // 上次查询时的数量，用于检测是否有新增
let pollTimer = null

function handleLogout() {
  clearToken()
  router.push('/login')
}

/**
 * 轮询待处理工单数量（每30秒）
 * 当有新工单时弹出桌面通知
 */
async function fetchPendingRepairs() {
  try {
    const res = await callAction('admin.repair.list', {
      page: 1,
      pageSize: 1
    })
    if (res.code === 0) {
      const count = res.data.total || 0
      pendingRepairCount.value = count

      // 检测到新增待处理工单 → 弹窗提醒
      if (count > lastCount.value && lastCount.value > 0) {
        ElNotification({
          title: '新报修工单',
          message: `当前有 ${count} 个待处理工单，请及时处理`,
          type: 'warning',
          duration: 5000,
          showClose: true
        })
      }
      lastCount.value = count
    }
  } catch (err) {
    console.error('查询待处理工单失败:', err)
  }
}

onMounted(() => {
  // 首次立即查询
  fetchPendingRepairs()
  // 每30秒轮询
  pollTimer = setInterval(fetchPendingRepairs, 30000)
})

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<style scoped>
.layout-container {
  height: 100vh;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
.el-aside {
  background: #fff;
  transition: width 0.3s;
  overflow: hidden;
  border-right: 1px solid #e4e7ed;
}
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #409eff;
  font-size: 18px;
  font-weight: bold;
  border-bottom: 1px solid #e4e7ed;
}
.el-menu {
  border-right: none;
}
.el-header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #eee;
  padding: 0 20px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.collapse-btn {
  font-size: 20px;
  cursor: pointer;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.username {
  font-size: 14px;
  color: #333;
}
.el-main {
  background: #f0f2f5;
  padding: 20px;
}
</style>
