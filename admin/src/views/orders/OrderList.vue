<template>
  <div>
    <h2 style="margin-bottom:20px">订单管理</h2>

    <el-card style="margin-bottom:16px">
      <el-form :inline="true" :model="filter">
        <el-form-item label="状态">
          <el-select v-model="filter.status" clearable placeholder="全部" style="width:120px">
            <el-option label="已完成" value="已完成" />
            <el-option label="已预约" value="已预约" />
            <el-option label="已取消" value="已取消" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间">
          <el-date-picker v-model="filter.dateRange" type="daterange" range-separator="至" start-placeholder="开始" end-placeholder="结束" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadOrders(true)">查询</el-button>
          <el-button @click="exportOrders">导出 Excel</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-table :data="orders" v-loading="loading" stripe @row-click="goDetail">
      <el-table-column prop="_id" label="订单号" width="200" />
      <el-table-column prop="deviceName" label="设备" width="120" />
      <el-table-column prop="_openid" label="用户" width="180" />
      <el-table-column label="套餐" width="80">
        <template #default="{ row }">
          <el-tag :type="row.package === 'quick' ? '' : 'warning'" size="small">
            {{ row.package === 'quick' ? '快洗' : row.package === 'dry' ? '烘干' : row.package || '-' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="finalPrice" label="金额" width="80" />
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="pageSize"
      :total="total"
      layout="prev, pager, next, total"
      style="margin-top:16px; justify-content:center"
      @current-change="loadOrders"
    />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { callAction } from '../../utils/request'

const router = useRouter()
const orders = ref([])
const loading = ref(false)
const page = ref(1)
const pageSize = 20
const total = ref(0)
const filter = reactive({ status: '', dateRange: null })

onMounted(() => loadOrders(true))

async function loadOrders(refresh = false) {
  if (refresh) page.value = 1
  loading.value = true

  const params = { page: page.value, pageSize }
  if (filter.status) params.status = filter.status
  if (filter.dateRange) {
    params.startDate = filter.dateRange[0].toISOString()
    params.endDate = filter.dateRange[1].toISOString()
  }

  const res = await callAction('admin.order.list', params)
  if (res.code === 0) {
    orders.value = res.data.orders
    total.value = res.data.total
  }
  loading.value = false
}

function statusType(s) {
  return s === '已完成' ? 'success' : s === '已取消' ? 'danger' : 'warning'
}

function formatTime(t) {
  return t ? new Date(t).toLocaleString() : ''
}

function goDetail(row) {
  router.push(`/orders/${row._id}`)
}

async function exportOrders() {
  const params = {}
  if (filter.status) params.status = filter.status
  if (filter.dateRange) {
    params.startDate = filter.dateRange[0].toISOString()
    params.endDate = filter.dateRange[1].toISOString()
  }

  const res = await callAction('admin.order.export', params)
  if (res.code === 0) {
    const link = document.createElement('a')
    link.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + res.data.base64
    link.download = res.data.fileName
    link.click()
  }
}
</script>
