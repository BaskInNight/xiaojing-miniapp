<template>
  <div>
    <h2 style="margin-bottom:20px">用户管理</h2>

    <el-card style="margin-bottom:16px">
      <el-input v-model="keyword" placeholder="搜索用户（昵称 / openid）" clearable style="width:300px" @clear="loadUsers(true)" @keyup.enter="loadUsers(true)">
        <template #append>
          <el-button @click="loadUsers(true)">搜索</el-button>
        </template>
      </el-input>
    </el-card>

    <el-table :data="users" v-loading="loading" stripe>
      <el-table-column label="头像" width="60">
        <template #default="{ row }">
          <el-avatar :size="32" :src="row.avatarUrl" />
        </template>
      </el-table-column>
      <el-table-column prop="nickName" label="昵称" width="150" />
      <el-table-column prop="_openid" label="openid" width="280" show-overflow-tooltip />
      <el-table-column prop="totalOrders" label="订单数" width="80" />
      <el-table-column label="最后登录" width="160">
        <template #default="{ row }">{{ formatTime(row.lastLoginAt) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="20"
      :total="total"
      layout="prev, pager, next, total"
      style="margin-top:16px"
      @current-change="loadUsers"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { callAction } from '../../utils/request'

const users = ref([])
const loading = ref(false)
const page = ref(1)
const total = ref(0)
const keyword = ref('')

onMounted(() => loadUsers())

async function loadUsers(refresh = false) {
  if (refresh) page.value = 1
  loading.value = true

  const params = { page: page.value, pageSize: 20 }
  if (keyword.value) params.keyword = keyword.value

  const res = await callAction('admin.user.list', params)
  if (res.code === 0) {
    users.value = res.data.users
    total.value = res.data.total
  }
  loading.value = false
}

function formatTime(t) {
  return t ? new Date(t).toLocaleString() : ''
}
</script>
