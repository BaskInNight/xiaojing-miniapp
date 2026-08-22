<template>
  <div>
    <h2 style="margin-bottom:20px">报修工单</h2>

    <el-card style="margin-bottom:16px">
      <el-input v-model="deviceId" placeholder="按设备编号筛选" clearable style="width:200px" @clear="loadRepairs(true)" @keyup.enter="loadRepairs(true)">
        <template #append>
          <el-button @click="loadRepairs(true)">筛选</el-button>
        </template>
      </el-input>
    </el-card>

    <el-table :data="repairs" v-loading="loading" stripe>
      <el-table-column prop="type" label="类型" width="100" />
      <el-table-column prop="deviceId" label="设备" width="120" />
      <el-table-column prop="description" label="描述" show-overflow-tooltip />
      <el-table-column prop="phone" label="联系电话" width="140" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === '待处理' ? 'warning' : 'success'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="提交时间" width="160">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button v-if="row.status === '待处理'" size="small" type="primary" @click="handleRepair(row)">处理</el-button>
          <span v-else>已完成</span>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="20"
      :total="total"
      layout="prev, pager, next, total"
      style="margin-top:16px"
      @current-change="loadRepairs"
    />

    <el-dialog v-model="dialogVisible" title="处理工单" width="400px">
      <p><strong>问题描述：</strong>{{ currentRepair?.description }}</p>
      <el-input v-model="remark" type="textarea" :rows="3" placeholder="填写维修备注" style="margin-top:12px" />
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmRepair">标记已完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { callAction } from '../../utils/request'

const repairs = ref([])
const loading = ref(false)
const page = ref(1)
const total = ref(0)
const deviceId = ref('')
const dialogVisible = ref(false)
const currentRepair = ref(null)
const remark = ref('')

onMounted(() => loadRepairs())

async function loadRepairs(refresh = false) {
  if (refresh) page.value = 1
  loading.value = true

  const params = { page: page.value, pageSize: 20 }
  if (deviceId.value) params.deviceId = deviceId.value

  const res = await callAction('admin.repair.list', params)
  if (res.code === 0) {
    repairs.value = res.data.repairs
    total.value = res.data.total
  }
  loading.value = false
}

function handleRepair(row) {
  currentRepair.value = row
  remark.value = ''
  dialogVisible.value = true
}

async function confirmRepair() {
  await callAction('admin.repair.update', {
    issueId: currentRepair.value._id,
    status: '已完成',
    remark: remark.value
  })
  dialogVisible.value = false
  loadRepairs()
}

function formatTime(t) {
  return t ? new Date(t).toLocaleString() : ''
}
</script>
