<template>
  <div>
    <h2 style="margin-bottom:20px">仪表盘</h2>

    <el-row :gutter="16" style="margin-bottom:20px">
      <el-col :span="6" v-for="card in cards" :key="card.label">
        <el-card shadow="hover">
          <div class="stat-card">
            <div class="stat-value">{{ card.value }}</div>
            <div class="stat-label">{{ card.label }}</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card>
          <template #header>订单总量趋势</template>
          <v-chart :option="lineOption" style="height:300px" autoresize />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>套餐收入占比</template>
          <v-chart :option="pieOption" style="height:300px" autoresize />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart, LineChart } from 'echarts/charts'
import { TitleComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'
import { callAction } from '../../utils/request'

use([CanvasRenderer, PieChart, LineChart, TitleComponent, TooltipComponent, LegendComponent])

const cards = ref([
  { label: '今日订单', value: '-' },
  { label: '今日营收', value: '-' },
  { label: '新增用户', value: '-' },
  { label: '设备活跃率', value: '-' }
])

const lineOption = ref({})
const pieOption = ref({})

onMounted(async () => {
  const res = await callAction('admin.dashboard')
  if (res.code === 0) {
    const d = res.data
    cards.value = [
      { label: '今日订单', value: d.todayOrders },
      { label: '今日营收', value: `¥${d.todayRevenue}` },
      { label: '新增用户', value: d.newUsers },
      { label: '设备活跃率', value: `${d.deviceActiveRate}%` }
    ]
  }

  // 演示数据
  lineOption.value = {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ['周一','周二','周三','周四','周五','周六','周日'] },
    yAxis: { type: 'value' },
    series: [{ type: 'line', data: [12, 18, 15, 22, 20, 28, 25], smooth: true }]
  }
  pieOption.value = {
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      data: [
        { name: '快洗', value: 65 },
        { name: '烘干', value: 35 }
      ]
    }]
  }
})
</script>

<style scoped>
.stat-card { text-align: center; padding: 8px 0; }
.stat-value { font-size: 32px; font-weight: bold; color: #409eff; }
.stat-label { font-size: 14px; color: #666; margin-top: 4px; }
</style>
