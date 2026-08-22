<template>
  <div>
    <el-button style="margin-bottom:16px" @click="router.back()">← 返回</el-button>

    <el-card v-loading="loading">
      <el-descriptions :column="2" border v-if="order">
        <el-descriptions-item label="订单号" :span="2">{{ order._id }}</el-descriptions-item>
        <el-descriptions-item label="设备">{{ order.deviceName }}</el-descriptions-item>
        <el-descriptions-item label="用户">{{ order._openid }}</el-descriptions-item>
        <el-descriptions-item label="套餐">{{ order.package === 'quick' ? '快洗' : order.package === 'dry' ? '烘干' : order.package || '-' }}</el-descriptions-item>
        <el-descriptions-item label="总时长">{{ order.totalTime || '-' }}分</el-descriptions-item>
        <el-descriptions-item label="金额">¥{{ order.finalPrice }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusType(order.status)">{{ order.status }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="优惠券抵扣">¥{{ order.usedCouponValue || 0 }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatTime(order.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="预约时间">{{ order.bookingDate }} {{ order.bookingTime }}</el-descriptions-item>
      </el-descriptions>

      <h3 v-if="order && order.steps" style="margin-top:24px">清洗步骤</h3>
      <el-table :data="stepList" v-if="stepList.length" stripe>
        <el-table-column prop="label" label="步骤" />
        <el-table-column prop="count" label="次数" />
        <el-table-column prop="time" label="单次时长" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { callAction } from '../../utils/request'

const route = useRoute()
const router = useRouter()
const order = ref(null)
const loading = ref(true)

const stepLabels = { soak: '浸泡', wash: '搓洗', rinse: '漂洗', dry: '烘干' }
const stepList = computed(() => {
  if (!order.value?.steps) return []
  return Object.entries(order.value.steps)
    .filter(([, v]) => v.enabled)
    .map(([k, v]) => ({ label: stepLabels[k] || k, count: v.count, time: `${v.time}分` }))
})

onMounted(async () => {
  const res = await callAction('admin.order.detail', { orderId: route.params.id })
  if (res.code === 0) order.value = res.data.order
  loading.value = false
})

function statusType(s) {
  return s === '已完成' ? 'success' : s === '已取消' ? 'danger' : 'warning'
}
function formatTime(t) {
  return t ? new Date(t).toLocaleString() : ''
}
</script>
