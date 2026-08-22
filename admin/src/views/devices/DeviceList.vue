<template>
  <div>
    <h2 style="margin-bottom:20px">设备管理</h2>

    <el-table :data="devices" v-loading="loading" stripe>
      <el-table-column prop="name" label="名称" width="120" />
      <el-table-column prop="bleName" label="蓝牙名" width="120" />
      <el-table-column prop="location" label="点位" />
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="故障" width="80">
        <template #default="{ row }">
          <el-tag v-if="row.fault" type="danger">故障</el-tag>
          <span v-else>正常</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button size="small" @click="editDevice(row)">编辑</el-button>
          <el-button v-if="!row.fault" size="small" type="warning" @click="markFault(row)">故障</el-button>
          <el-button v-else size="small" type="success" @click="clearFault(row)">清除故障</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="50"
      :total="total"
      layout="prev, pager, next, total"
      style="margin-top:16px"
      @current-change="loadDevices"
    />

    <el-dialog v-model="editVisible" :title="'编辑 - ' + editForm.name" width="500px">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="名称"><el-input v-model="editForm.name" /></el-form-item>
        <el-form-item label="蓝牙名"><el-input v-model="editForm.bleName" /></el-form-item>
        <el-form-item label="点位"><el-input v-model="editForm.location" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="editForm.status">
            <el-option label="online" value="online" />
            <el-option label="offline" value="offline" />
            <el-option label="working" value="working" />
            <el-option label="fault" value="fault" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="saveDevice">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="faultVisible" title="标记故障" width="400px">
      <el-input v-model="faultReason" type="textarea" :rows="3" placeholder="请输入故障原因" />
      <template #footer>
        <el-button @click="faultVisible = false">取消</el-button>
        <el-button type="warning" @click="confirmFault">确认故障</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { callAction } from '../../utils/request'

const devices = ref([])
const loading = ref(false)
const page = ref(1)
const total = ref(0)
const editVisible = ref(false)
const editForm = ref({})
const faultVisible = ref(false)
const faultDevice = ref(null)
const faultReason = ref('')

onMounted(() => loadDevices())

async function loadDevices() {
  loading.value = true
  const res = await callAction('admin.device.list', { page: page.value, pageSize: 50 })
  if (res.code === 0) {
    devices.value = res.data.devices
    total.value = res.data.total
  }
  loading.value = false
}

function statusType(s) {
  return s === 'online' || s === '空闲' ? 'success' : s === 'working' ? 'primary' : s === 'fault' ? 'danger' : 'info'
}

function editDevice(row) {
  editForm.value = { ...row }
  editVisible.value = true
}

async function saveDevice() {
  await callAction('admin.device.update', { deviceId: editForm.value._id, ...editForm.value })
  editVisible.value = false
  loadDevices()
}

function markFault(row) {
  faultDevice.value = row
  faultReason.value = ''
  faultVisible.value = true
}

async function confirmFault() {
  await callAction('admin.device.update', {
    deviceId: faultDevice.value._id,
    fault: true,
    faultReason: faultReason.value || '未知故障',
    status: 'fault'
  })
  faultVisible.value = false
  loadDevices()
}

async function clearFault(row) {
  await callAction('admin.device.update', {
    deviceId: row._id,
    fault: false,
    faultReason: '',
    status: 'online'
  })
  loadDevices()
}
</script>
