import axios from 'axios'
import { ElMessage } from 'element-plus'
import { getToken, clearToken } from './auth'
import router from '../router'

const API_BASE = 'https://cloud1-d6g8uxp6ha8bb9404-1434679274.ap-shanghai.app.tcloudbase.com/admin'

const request = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
})

// 请求拦截器：自动注入 token
request.interceptors.request.use(config => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器
request.interceptors.response.use(res => {
  const data = res.data
  if (data.code === 401) {
    clearToken()
    router.push('/login')
    ElMessage.error('登录已过期，请重新登录')
    return Promise.reject(new Error(data.msg))
  }
  return data
}, err => {
  ElMessage.error('网络请求失败')
  return Promise.reject(err)
})

// 统一调用方法
export function callAction(action, params = {}) {
  return request.post('/', { action, ...params })
}

export default request
