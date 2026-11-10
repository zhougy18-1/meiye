<template>
  <div class="sms-page">
    <div class="page-heading">
      <div>
        <h2>消费短信</h2>
        <p>会员结算后发送消费金额、时间和账户余额，短信失败不影响收银。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert
      v-if="config.isSimulation"
      type="warning" :closable="false" show-icon
      title="当前是模拟短信模式：会生成发送记录，但不会向真实手机发送；模拟记录不会被标记为已送达。"
    />
    <el-alert
      v-else-if="!config.enabled || !config.configured"
      type="error" :closable="false" show-icon
      title="真实短信尚未配置完成，请完成腾讯云资质、签名、模板和密钥配置。"
    />

    <div class="summary-grid">
      <el-card shadow="never"><span>总记录</span><strong>{{ total }}</strong></el-card>
      <el-card shadow="never"><span>模拟成功（未送达）</span><strong class="warning-text">{{ counts.SIMULATED || 0 }}</strong></el-card>
      <el-card shadow="never"><span>等待发送</span><strong>{{ pendingCount }}</strong></el-card>
      <el-card shadow="never"><span>发送失败</span><strong class="danger">{{ counts.FAILED || 0 }}</strong></el-card>
    </div>

    <div class="receipt-grid">
      <el-card shadow="never"><span>已受理（中间态）</span><strong>{{ counts.ACCEPTED || 0 }}</strong></el-card>
      <el-card shadow="never"><span>已送达</span><strong class="success-text">{{ counts.DELIVERED || 0 }}</strong></el-card>
      <el-card shadow="never"><span>运营商退回</span><strong class="danger">{{ counts.REJECTED || 0 }}</strong></el-card>
    </div>

    <div class="toolbar">
      <el-select v-model="filters.status" clearable placeholder="全部状态" style="width: 200px" @change="load">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <small>仅向在会员资料中已开启“消费短信”的顾客生成通知。</small>
    </div>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
      </el-table-column>
      <el-table-column label="会员" min-width="130">
        <template #default="{ row }"><strong>{{ row.member?.name || '已删除会员' }}</strong><div class="muted">{{ row.phoneMasked }}</div></template>
      </el-table-column>
      <el-table-column label="消费" width="100"><template #default="{ row }">¥{{ row.amount }}</template></el-table-column>
      <el-table-column label="余额" width="100"><template #default="{ row }">¥{{ row.balanceAfter }}</template></el-table-column>
      <el-table-column prop="messagePreview" label="短信预览" min-width="310" show-overflow-tooltip />
      <el-table-column label="状态" width="125">
        <template #default="{ row }"><el-tag :type="statusMeta(row.status).type">{{ statusMeta(row.status).text }}</el-tag></template>
      </el-table-column>
      <el-table-column label="处理" width="100" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'FAILED'" link type="primary" :loading="retrying === row.id" @click="retry(row)">重试</el-button>
          <el-tooltip v-else-if="row.errorMessage" :content="row.errorMessage"><span class="muted">查看原因</span></el-tooltip>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="total > filters.limit" class="pager">
      <el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getSmsConfig, getSmsNotifications, retrySmsNotification } from '@/api/sms.js';
// 依赖待决 Q-09：八态选项 / 标签 / 标签色集中取自前端展示镜像，口径以后端为准。
import { SMS_STATUS_OPTIONS, SMS_STATUS_LABELS, SMS_STATUS_TAG_TYPES } from '@/constants/p0Gap.js';

const loading = ref(false);
const retrying = ref('');
const rows = ref([]);
const total = ref(0);
const counts = reactive({});
const config = reactive({ enabled: false, configured: false, isSimulation: false });
const filters = reactive({ page: 1, limit: 20, status: '' });
const statusOptions = SMS_STATUS_OPTIONS;

const pendingCount = computed(() => (counts.PENDING || 0) + (counts.SENDING || 0));

function statusMeta(status) {
  return {
    text: SMS_STATUS_LABELS[status] || status,
    type: SMS_STATUS_TAG_TYPES[status] || 'info',
  };
}

async function load() {
  loading.value = true;
  try {
    const [configData, data] = await Promise.all([
      getSmsConfig(), getSmsNotifications({ ...filters, status: filters.status || undefined }),
    ]);
    Object.assign(config, configData);
    rows.value = data.data;
    total.value = data.total;
    Object.keys(counts).forEach(key => delete counts[key]);
    Object.assign(counts, data.counts || {});
  } finally { loading.value = false; }
}

async function retry(row) {
  retrying.value = row.id;
  try { await retrySmsNotification(row.id); ElMessage.success('已重试发送'); await load(); }
  finally { retrying.value = ''; }
}

const formatDate = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
onMounted(load);
</script>

<style scoped>
.sms-page { display: grid; gap: 18px; }
.page-heading, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-heading h2 { margin: 0 0 6px; }
.page-heading p, .muted, small { color: #909399; margin: 0; }
.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.receipt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: -8px; }
.summary-grid :deep(.el-card__body), .receipt-grid :deep(.el-card__body) { display: flex; flex-direction: column; gap: 8px; }
.summary-grid strong, .receipt-grid strong { font-size: 26px; color: var(--el-color-primary); }
.summary-grid .danger, .receipt-grid .danger { color: var(--el-color-danger); }
.summary-grid .warning-text, .receipt-grid .warning-text { color: var(--el-color-warning); }
.summary-grid .success-text, .receipt-grid .success-text { color: var(--el-color-success); }
.pager { display: flex; justify-content: flex-end; }
@media (max-width: 767px) {
  .page-heading, .toolbar { align-items: stretch; flex-direction: column; }
  .summary-grid { grid-template-columns: repeat(2, 1fr); }
  .receipt-grid { grid-template-columns: repeat(2, 1fr); margin-top: 0; }
}
</style>
