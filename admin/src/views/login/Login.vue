<template>
  <div class="login-page">
    <div class="login-box">
      <h1>净界同频 · 管理后台</h1>
      <el-form ref="formRef" :model="form" :rules="rules" @keyup.enter="handleLogin">
        <el-form-item prop="username">
          <el-input v-model="form.username" placeholder="账号" size="large" />
        </el-form-item>
        <el-form-item prop="password">
          <el-input v-model="form.password" type="password" placeholder="密码" size="large" show-password />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" size="large" :loading="loading" style="width:100%" @click="handleLogin">
            登 录
          </el-button>
        </el-form-item>
      </el-form>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { callAction } from '../../utils/request'
import { setToken, setUser } from '../../utils/auth'

const router = useRouter()
const formRef = ref(null)
const loading = ref(false)
const error = ref('')

const form = reactive({ username: '', password: '' })
const rules = {
  username: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

async function handleLogin() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  error.value = ''

  const res = await callAction('admin.login', {
    username: form.username,
    password: form.password
  })

  loading.value = false

  if (res.code === 0) {
    setToken(res.data.token)
    setUser({ username: form.username })
    router.push('/dashboard')
  } else {
    error.value = res.msg || '登录失败'
  }
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #0A1628, #1a2a4a);
}
.login-box {
  width: 380px;
  padding: 40px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
h1 {
  text-align: center;
  font-size: 24px;
  margin-bottom: 32px;
  color: #333;
}
.error {
  color: #f56c6c;
  text-align: center;
  font-size: 14px;
  margin-top: 8px;
}
</style>
