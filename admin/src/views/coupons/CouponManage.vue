<template>
  <div>
    <h2 style="margin-bottom:20px">优惠券管理</h2>

    <!-- 统计卡片 -->
    <el-row :gutter="16" style="margin-bottom:20px">
      <el-col :span="6">
        <el-card>
          <div class="stat-card">
            <div class="stat-value">{{ stats.adToday }}</div>
            <div class="stat-label">今日广告发放</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card>
          <div class="stat-card">
            <div class="stat-value">{{ stats.usedTotal }}</div>
            <div class="stat-label">总核销量</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card>
          <div class="stat-card">
            <div class="stat-value">{{ stats.totalIssued }}</div>
            <div class="stat-label">总发放量</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card>
          <div class="stat-card">
            <div class="stat-value">{{ templates.length }}</div>
            <div class="stat-label">模板数量</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 标签页 -->
    <el-tabs v-model="activeTab" type="card">
      <!-- ========== 模板管理 ========== -->
      <el-tab-pane label="优惠券模板" name="templates">
        <el-card>
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span>模板列表</span>
              <el-button type="primary" size="small" @click="openAddTemplate">新增模板</el-button>
            </div>
          </template>
          <el-table :data="templates" v-loading="loadingTemplates" stripe>
            <el-table-column prop="name" label="名称" min-width="140" />
            <el-table-column label="类型" width="110">
              <template #default="{ row }">{{ typeMap[row.type] || row.type }}</template>
            </el-table-column>
            <el-table-column prop="value" label="面值(元)" width="100" />
            <el-table-column prop="validDays" label="有效期(天)" width="100" />
            <el-table-column prop="description" label="描述" min-width="160" show-overflow-tooltip />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                  {{ row.isActive ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="openEditTemplate(row)">编辑</el-button>
                <el-button
                  size="small"
                  :type="row.isActive ? 'warning' : 'success'"
                  @click="toggleTemplate(row)"
                >
                  {{ row.isActive ? '停用' : '启用' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ========== 发放记录 ========== -->
      <el-tab-pane label="发放记录" name="records">
        <el-card style="margin-bottom:16px">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <el-select
              v-model="recordFilter.status"
              placeholder="全部状态"
              clearable
              style="width:130px"
            >
              <el-option label="未使用" value="unused" />
              <el-option label="已使用" value="used" />
              <el-option label="已过期" value="expired" />
            </el-select>
            <el-input
              v-model="recordFilter.keyword"
              placeholder="搜索用户昵称 / openid"
              clearable
              style="width:260px"
              @keyup.enter="loadRecords(true)"
            />
            <el-button type="primary" @click="loadRecords(true)">搜索</el-button>
            <el-button type="success" @click="showIssue = true; loadUserOptions()">手动发放</el-button>
          </div>
        </el-card>

        <el-card>
          <el-table :data="records" v-loading="loadingRecords" stripe>
            <el-table-column prop="nickName" label="用户" width="120" />
            <el-table-column prop="_openid" label="openid" width="200" show-overflow-tooltip />
            <el-table-column prop="templateName" label="优惠券" width="140" />
            <el-table-column prop="value" label="面值(元)" width="90" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small">
                  {{ statusMap[row.status] || row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">{{ sourceMap[row.source] || row.source }}</template>
            </el-table-column>
            <el-table-column label="过期时间" width="170">
              <template #default="{ row }">{{ formatTime(row.expireAt) }}</template>
            </el-table-column>
            <el-table-column label="发放时间" width="170">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="recordPage"
            :page-size="20"
            :total="recordTotal"
            layout="prev, pager, next, total"
            style="margin-top:16px"
            @current-change="loadRecords"
          />
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 新增模板对话框 -->
    <el-dialog v-model="showAddTemplate" title="新增模板" width="500px">
      <el-form :model="templateForm" label-width="100px">
        <el-form-item label="名称" required>
          <el-input v-model="templateForm.name" placeholder="如：新人专享券" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="templateForm.type" style="width:100%">
            <el-option label="洗涤优惠" value="wash_discount" />
            <el-option label="满减券" value="full_reduction" />
            <el-option label="通用券" value="general" />
          </el-select>
        </el-form-item>
        <el-form-item label="面值(元)" required>
          <el-input-number v-model="templateForm.value" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="有效期(天)" required>
          <el-input-number v-model="templateForm.validDays" :min="1" :max="365" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="templateForm.description" type="textarea" :rows="3" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddTemplate = false">取消</el-button>
        <el-button type="primary" :loading="savingTemplate" @click="doAddTemplate">保存</el-button>
      </template>
    </el-dialog>

    <!-- 编辑模板对话框 -->
    <el-dialog v-model="showEditTemplate" title="编辑模板" width="500px">
      <el-form :model="editForm" label-width="100px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="editForm.type" style="width:100%">
            <el-option label="洗涤优惠" value="wash_discount" />
            <el-option label="满减券" value="full_reduction" />
            <el-option label="通用券" value="general" />
          </el-select>
        </el-form-item>
        <el-form-item label="面值(元)">
          <el-input-number v-model="editForm.value" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="有效期(天)">
          <el-input-number v-model="editForm.validDays" :min="1" :max="365" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditTemplate = false">取消</el-button>
        <el-button type="primary" :loading="savingTemplate" @click="doEditTemplate">保存</el-button>
      </template>
    </el-dialog>

    <!-- 手动发放对话框 -->
    <el-dialog v-model="showIssue" title="手动发放优惠券" width="480px">
      <el-form :model="issueForm" label-width="100px">
        <el-form-item label="选择用户" required>
          <el-select
            v-model="issueForm.openid"
            filterable
            remote
            :remote-method="searchUsers"
            placeholder="输入用户昵称搜索"
            style="width:100%"
            :loading="searchingUser"
          >
            <el-option
              v-for="u in userOptions"
              :key="u._openid"
              :label="`${u.nickName} (${u._openid?.slice(0,12)}...)`"
              :value="u._openid"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="选择模板" required>
          <el-select v-model="issueForm.templateId" style="width:100%">
            <el-option v-for="t in templates" :key="t._id" :label="t.name" :value="t._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="issueForm.count" :min="1" :max="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="closeIssue">取消</el-button>
        <el-button type="primary" :loading="issuing" @click="doIssue">发放</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import { callAction } from '../../utils/request'

// ==================== 映射表 ====================
const statusMap = { unused: '未使用', used: '已使用', expired: '已过期' }
const sourceMap = { ad: '广告', manual: '手动', unknown: '未知' }
const typeMap = { wash_discount: '洗涤优惠', full_reduction: '满减券', general: '通用券' }

function statusTagType(status) {
  return status === 'used' ? 'success' : status === 'expired' ? 'info' : 'warning'
}

function formatTime(t) {
  return t ? new Date(t).toLocaleString() : '-'
}

// ==================== 数据加载 ====================
const templates = ref([])
const stats = reactive({ adToday: '-', usedTotal: '-', totalIssued: '-' })
const activeTab = ref('templates')
const loadingTemplates = ref(false)

onMounted(() => {
  loadTemplates()
  loadStats()
})

async function loadTemplates() {
  loadingTemplates.value = true
  const res = await callAction('admin.coupon.templates')
  if (res.code === 0) templates.value = res.data.templates
  loadingTemplates.value = false
}

async function loadStats() {
  const res = await callAction('admin.coupon.stats')
  if (res.code === 0) {
    stats.adToday = res.data.adToday
    stats.usedTotal = res.data.usedTotal
    stats.totalIssued = res.data.totalIssued
  }
}

// ==================== 模板 CRUD ====================
const showAddTemplate = ref(false)
const showEditTemplate = ref(false)
const savingTemplate = ref(false)
const templateForm = reactive({
  name: '', type: 'wash_discount', value: 1, validDays: 30, description: ''
})
const editForm = reactive({
  templateId: '', name: '', type: 'wash_discount', value: 1, validDays: 30, description: ''
})

function openAddTemplate() {
  templateForm.name = ''
  templateForm.type = 'wash_discount'
  templateForm.value = 1
  templateForm.validDays = 30
  templateForm.description = ''
  showAddTemplate.value = true
}

async function doAddTemplate() {
  if (!templateForm.name) return
  savingTemplate.value = true
  const res = await callAction('admin.coupon.template.add', { ...templateForm })
  savingTemplate.value = false
  if (res.code === 0) {
    showAddTemplate.value = false
    loadTemplates()
    loadStats()
  }
}

function openEditTemplate(row) {
  editForm.templateId = row._id
  editForm.name = row.name
  editForm.type = row.type
  editForm.value = row.value
  editForm.validDays = row.validDays
  editForm.description = row.description || ''
  showEditTemplate.value = true
}

async function doEditTemplate() {
  savingTemplate.value = true
  const res = await callAction('admin.coupon.template.update', { ...editForm })
  savingTemplate.value = false
  if (res.code === 0) {
    showEditTemplate.value = false
    loadTemplates()
  }
}

async function toggleTemplate(row) {
  const res = await callAction('admin.coupon.template.toggle', {
    templateId: row._id,
    isActive: !row.isActive
  })
  if (res.code === 0) loadTemplates()
}

// 切换标签时加载发放记录
watch(activeTab, (val) => {
  if (val === 'records' && records.value.length === 0) {
    loadRecords()
  }
})

// ==================== 发放记录 ====================
const records = ref([])
const loadingRecords = ref(false)
const recordPage = ref(1)
const recordTotal = ref(0)
const recordFilter = reactive({ status: '', keyword: '' })

async function loadRecords(refresh = false) {
  if (refresh) recordPage.value = 1
  loadingRecords.value = true
  const res = await callAction('admin.coupon.list', {
    page: recordPage.value,
    pageSize: 20,
    status: recordFilter.status || undefined,
    keyword: recordFilter.keyword || undefined
  })
  if (res.code === 0) {
    records.value = res.data.coupons
    recordTotal.value = res.data.total
  }
  loadingRecords.value = false
}

// ==================== 手动发放 ====================
const showIssue = ref(false)
const issuing = ref(false)
const issueForm = reactive({ openid: '', templateId: '', count: 1 })
const userOptions = ref([])
const searchingUser = ref(false)

function loadUserOptions() {
  searchUsers('')
}

async function searchUsers(keyword) {
  searchingUser.value = true
  const res = await callAction('admin.user.list', {
    keyword: keyword || undefined,
    pageSize: keyword ? 10 : 20
  })
  searchingUser.value = false
  if (res.code === 0) userOptions.value = res.data.users
}

function closeIssue() {
  showIssue.value = false
  issueForm.openid = ''
  issueForm.templateId = ''
  issueForm.count = 1
}

async function doIssue() {
  if (!issueForm.openid || !issueForm.templateId) return
  issuing.value = true
  const res = await callAction('admin.coupon.issue', { ...issueForm })
  issuing.value = false
  if (res.code === 0) {
    closeIssue()
    loadStats()
    loadRecords(true)
  }
}
</script>

<style scoped>
.stat-card { text-align: center; padding: 8px 0; }
.stat-value { font-size: 28px; font-weight: bold; color: #409eff; }
.stat-label { font-size: 14px; color: #666; margin-top: 4px; }
</style>
