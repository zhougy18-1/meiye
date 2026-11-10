<template>
  <div class="package-page">
    <div class="page-heading">
      <div>
        <h2>套餐次卡</h2>
        <p>购买时记一次收款，护理时只扣次数，避免重复计算营业收入。</p>
      </div>
      <div v-if="canManage" class="heading-actions">
        <el-button @click="planDialog = true">新建套餐</el-button>
        <el-button type="primary" @click="openPurchase">办理套餐</el-button>
      </div>
    </div>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="套餐收入使用独立台账，未合并原收银报表；扣次不会再次记收款。退款/作废只变更状态并留痕，套餐与历史扣次不会删除。"
    />

    <div class="summary-grid">
      <el-card shadow="never"><span>已售套餐</span><strong>{{ summary.holdingCount || 0 }}</strong></el-card>
      <el-card shadow="never"><span>套餐实收</span><strong>¥{{ summary.paidAmount || '0.00' }}</strong></el-card>
      <el-card shadow="never"><span>已核销次数</span><strong>{{ summary.redeemedUses || 0 }}</strong></el-card>
      <el-card shadow="never"><span>剩余次数</span><strong>{{ summary.remainingUses || 0 }}</strong></el-card>
    </div>

    <div class="toolbar">
      <el-input v-model="keyword" clearable placeholder="搜索顾客、手机号或套餐" style="max-width: 320px" />
      <el-button @click="loadAll">刷新</el-button>
    </div>

    <el-table :data="filteredHoldings" v-loading="loading" row-key="id" stripe>
      <el-table-column type="expand">
        <template #default="scope">
          <div class="usage-panel">
            <div class="usage-title">使用记录</div>
            <el-empty v-if="!scope.row.usages?.length" description="还没有扣次记录" :image-size="64" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="usage in scope.row.usages"
                :key="usage.id"
                :timestamp="formatDate(usage.usedAt)"
                :type="usage.reversedAt ? 'info' : 'success'"
              >
                <div>
                  扣 1 次 · 操作人 {{ usage.usedByName }}
                  <el-tag v-if="usage.reversedAt" type="info" size="small">已撤销</el-tag>
                </div>
                <small v-if="usage.note">备注：{{ usage.note }}</small>
                <small v-if="usage.reversedAt">撤销原因：{{ usage.reverseReason }}（{{ usage.reversedByName }}）</small>
                <el-button
                  v-if="canManage && !usage.reversedAt"
                  link type="danger" size="small"
                  @click="reverseUsage(usage)"
                >撤销本次扣次</el-button>
              </el-timeline-item>
            </el-timeline>

            <div class="audit-panel">
              <div class="usage-title">退款 / 作废审计记录</div>
              <el-empty v-if="!auditMap[scope.row.id]?.length" description="暂无退款或作废记录" :image-size="56" />
              <el-table v-else :data="auditMap[scope.row.id]" size="small" border>
                <el-table-column label="时间" width="165">
                  <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
                </el-table-column>
                <el-table-column label="动作" width="80">
                  <template #default="{ row }">{{ row.action === 'REFUND' ? '退款' : '作废' }}</template>
                </el-table-column>
                <el-table-column label="退款金额" width="105">
                  <template #default="{ row }">¥{{ row.refundAmount }}</template>
                </el-table-column>
                <el-table-column label="剩余次数" width="105">
                  <template #default="{ row }">{{ row.remainingUsesBefore }} → {{ row.remainingUsesAfter }}</template>
                </el-table-column>
                <el-table-column label="前置状态" width="95">
                  <template #default="{ row }">{{ row.prevStatus }}</template>
                </el-table-column>
                <el-table-column label="原因" min-width="150">
                  <template #default="{ row }">{{ row.reason }}</template>
                </el-table-column>
                <el-table-column label="审批人" width="110">
                  <template #default="{ row }">{{ row.approvedBy }}</template>
                </el-table-column>
                <el-table-column label="操作人" width="110">
                  <template #default="{ row }">{{ row.operatorName }}</template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="顾客" min-width="130">
        <template #default="scope">
          <strong>{{ scope.row.member.name }}</strong>
          <div class="muted">{{ scope.row.member.phone }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="planName" label="套餐" min-width="150" />
      <el-table-column label="项目" min-width="120">
        <template #default="scope">{{ scope.row.plan?.service?.name || '-' }}</template>
      </el-table-column>
      <el-table-column label="剩余/总次数" width="125">
        <template #default="scope"><strong>{{ scope.row.remainingUses }}</strong> / {{ scope.row.totalUses }}</template>
      </el-table-column>
      <el-table-column label="实收" width="100">
        <template #default="scope">¥{{ scope.row.paidAmount }}</template>
      </el-table-column>
      <el-table-column label="有效期" min-width="145">
        <template #default="scope">{{ scope.row.expiresAt ? formatDate(scope.row.expiresAt, true) : '长期有效' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="95">
        <template #default="scope">
          <el-tag :type="statusType(scope.row)">{{ statusText(scope.row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="290" fixed="right">
        <template #default="scope">
          <el-button
            type="primary" size="small"
            :disabled="!canRedeem(scope.row)"
            :loading="busyId === scope.row.id"
            @click="redeem(scope.row)"
          >扣 1 次</el-button>
          <el-button
            v-if="canManage && !isClosed(scope.row)" size="small"
            @click="toggleStatus(scope.row)"
          >{{ scope.row.status === 'ACTIVE' ? '暂停' : '恢复' }}</el-button>
          <el-button
            v-if="canManage && canCloseout(scope.row)" size="small" type="warning"
            @click="openCloseout(scope.row, 'REFUND')"
          >退款</el-button>
          <el-button
            v-if="canManage && canCloseout(scope.row)" size="small" type="danger"
            @click="openCloseout(scope.row, 'VOID')"
          >作废</el-button>
          <el-button size="small" link type="info" @click="openAudits(scope.row)">审计</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="planDialog" title="新建套餐模板" width="480px">
      <el-form :model="planForm" label-width="90px">
        <el-form-item label="套餐名称" required><el-input v-model="planForm.name" placeholder="例如：大白肌3次体验" /></el-form-item>
        <el-form-item label="护理项目" required>
          <el-select v-model="planForm.serviceId" style="width:100%" placeholder="选择项目">
            <el-option v-for="item in services" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="可用次数" required><el-input-number v-model="planForm.totalUses" :min="1" :max="1000" /></el-form-item>
        <el-form-item label="售价" required><el-input v-model="planForm.price" prefix-icon="Money" /></el-form-item>
        <el-form-item label="有效天数"><el-input-number v-model="planForm.validDays" :min="1" :max="3650" placeholder="留空为长期" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="planDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="savePlan">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="purchaseDialog" title="为顾客办理套餐" width="500px">
      <el-form :model="purchaseForm" label-width="90px">
        <el-form-item label="顾客" required>
          <el-select v-model="purchaseForm.memberId" filterable style="width:100%" placeholder="按姓名或手机号搜索">
            <el-option v-for="item in members" :key="item.id" :label="`${item.name} · ${item.phone}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="套餐" required>
          <el-select v-model="purchaseForm.planId" style="width:100%" @change="applyPlanPrice">
            <el-option v-for="item in activePlans" :key="item.id" :label="`${item.name} · ${item.totalUses}次 · ¥${item.price}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="实际收款" required><el-input v-model="purchaseForm.paidAmount" /></el-form-item>
        <el-form-item label="支付方式" required>
          <el-select v-model="purchaseForm.paymentMethod" style="width:100%">
            <el-option v-for="item in paymentOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" title="请只在这里记录套餐收款，不要再到普通收银页重复开单。" />
      <template #footer><el-button @click="closePurchase">取消</el-button><el-button type="primary" :loading="saving" @click="savePurchase">确认办理</el-button></template>
    </el-dialog>

    <el-dialog
      v-model="closeoutDialog"
      :title="closeoutForm.action === 'REFUND' ? '套餐退款' : '套餐作废'"
      width="540px"
    >
      <el-form :model="closeoutForm" label-width="120px">
        <el-form-item label="套餐 / 顾客">
          <span>{{ closeoutTarget?.planName }} · {{ closeoutTarget?.member?.name || '-' }}</span>
        </el-form-item>
        <el-form-item label="实收 / 剩余次数">
          <span>¥{{ closeoutTarget?.paidAmount }} · {{ closeoutTarget?.remainingUses }} / {{ closeoutTarget?.totalUses }} 次</span>
        </el-form-item>
        <el-form-item v-if="closeoutForm.action === 'REFUND'" label="退款金额" required>
          <el-input v-model="closeoutForm.refundAmount" placeholder="按剩余次数比例计算上限，累计不超过实收" />
        </el-form-item>
        <el-form-item v-else label="退款金额">
          <span>0.00（作废无退款金额）</span>
        </el-form-item>
        <el-form-item label="剩余次数处理">
          <span>剩余次数归零，状态置「{{ closeoutForm.action === 'REFUND' ? '已退款' : '已作废' }}」，不可再扣次；历史扣次保留</span>
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="closeoutForm.reason" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="必填" />
        </el-form-item>
        <el-form-item label="审批人" required>
          <el-input v-model="closeoutForm.approvedBy" maxlength="191" placeholder="必填：审批人标识 / 姓名" />
        </el-form-item>
        <el-form-item label="时间"><span>由系统自动记录</span></el-form-item>
      </el-form>
      <el-alert
        type="info" :closable="false"
        title="仅变更套餐状态并写入审计，不删除套餐与历史扣次，不写入旧收银流水；退款在报表以「套餐退款」分列。"
      />
      <template #footer>
        <el-button @click="closeoutDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCloseout">
          确认{{ closeoutForm.action === 'REFUND' ? '退款' : '作废' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="auditDialog" title="套餐退款 / 作废审计记录" width="860px">
      <el-empty v-if="!currentAudits.length" description="暂无退款或作废记录" :image-size="72" />
      <el-table v-else :data="currentAudits" size="small" border>
        <el-table-column label="时间" width="165">
          <template #default="{ row }">{{ formatDate(row.occurredAt) }}</template>
        </el-table-column>
        <el-table-column label="动作" width="80">
          <template #default="{ row }">{{ row.action === 'REFUND' ? '退款' : '作废' }}</template>
        </el-table-column>
        <el-table-column label="退款金额" width="105">
          <template #default="{ row }">¥{{ row.refundAmount }}</template>
        </el-table-column>
        <el-table-column label="剩余次数" width="105">
          <template #default="{ row }">{{ row.remainingUsesBefore }} → {{ row.remainingUsesAfter }}</template>
        </el-table-column>
        <el-table-column label="前置状态" width="95">
          <template #default="{ row }">{{ row.prevStatus }}</template>
        </el-table-column>
        <el-table-column label="原因" min-width="150">
          <template #default="{ row }">{{ row.reason }}</template>
        </el-table-column>
        <el-table-column label="审批人" width="110">
          <template #default="{ row }">{{ row.approvedBy }}</template>
        </el-table-column>
        <el-table-column label="操作人" width="110">
          <template #default="{ row }">{{ row.operatorName }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { getMembers } from '@/api/member.js';
import {
  createPackagePlan, getPackageHoldings, getPackagePlans, getPackageServices,
  getPackageSummary, purchasePackage, redeemPackage, reversePackageUsage, setPackageStatus,
  refundPackage, voidPackage, getPackageAudits,
} from '@/api/package.js';

const userStore = useUserStore();
const canManage = computed(() => ['ADMIN', 'MANAGER'].includes(userStore.userRole));
const loading = ref(false);
const saving = ref(false);
const busyId = ref('');
const keyword = ref('');
const holdings = ref([]);
const plans = ref([]);
const services = ref([]);
const members = ref([]);
const summary = reactive({ holdingCount: 0, paidAmount: '0.00', redeemedUses: 0, remainingUses: 0 });
const planDialog = ref(false);
const purchaseDialog = ref(false);
const planForm = reactive({ name: '', serviceId: '', totalUses: 3, price: '99.00', validDays: 90 });
const purchaseForm = reactive({ memberId: '', planId: '', paidAmount: '', paymentMethod: 'DOUYIN', requestKey: '' });
const paymentOptions = [
  { value: 'WECHAT_PAY', label: '微信支付' }, { value: 'ALIPAY', label: '支付宝' },
  { value: 'DOUYIN', label: '抖音' }, { value: 'MEITUAN', label: '美团' },
  { value: 'CASH', label: '现金' }, { value: 'CARD_SWIPE', label: '银行卡' }, { value: 'OTHER', label: '其他' },
];

// P0 缺口补齐：退款/作废表单、审计记录（口径以后端 p0GapPolicies.js 为准）。
const closeoutDialog = ref(false);
const closeoutTarget = ref(null);
const closeoutForm = reactive({ action: 'REFUND', refundAmount: '', reason: '', approvedBy: '', requestKey: '' });
const auditDialog = ref(false);
const auditTarget = ref(null);
const auditMap = reactive({});
const currentAudits = computed(() => (auditTarget.value ? auditMap[auditTarget.value.id] || [] : []));

const activePlans = computed(() => plans.value.filter(item => item.active));
const filteredHoldings = computed(() => {
  const key = keyword.value.trim().toLowerCase();
  if (!key) return holdings.value;
  return holdings.value.filter(item => [item.member?.name, item.member?.phone, item.planName, item.plan?.service?.name]
    .some(value => String(value || '').toLowerCase().includes(key)));
});

async function loadAll() {
  loading.value = true;
  try {
    const [holdingData, planData, serviceData, memberData, summaryData] = await Promise.all([
      getPackageHoldings(), getPackagePlans(), getPackageServices(),
      getMembers({ page: 1, limit: 100 }), getPackageSummary(),
    ]);
    holdings.value = holdingData;
    plans.value = planData;
    services.value = serviceData;
    members.value = memberData.members || memberData.data || [];
    Object.assign(summary, summaryData);
    const auditEntries = await Promise.all(
      holdingData.map(async item => [item.id, await getPackageAudits(item.id).catch(() => [])]),
    );
    Object.keys(auditMap).forEach(key => delete auditMap[key]);
    Object.assign(auditMap, Object.fromEntries(auditEntries));
  } finally { loading.value = false; }
}

async function savePlan() {
  if (!planForm.name.trim() || !planForm.serviceId || Number(planForm.price) <= 0) return ElMessage.warning('请完整填写套餐信息');
  saving.value = true;
  try {
    await createPackagePlan({ ...planForm, name: planForm.name.trim(), price: Number(planForm.price).toFixed(2), validDays: planForm.validDays || null });
    ElMessage.success('套餐模板已创建');
    planDialog.value = false;
    await loadAll();
  } finally { saving.value = false; }
}

function openPurchase() {
  purchaseForm.requestKey = crypto.randomUUID();
  purchaseDialog.value = true;
}
function closePurchase() { purchaseDialog.value = false; purchaseForm.requestKey = ''; }
function applyPlanPrice(id) {
  const item = plans.value.find(plan => plan.id === id);
  if (item) purchaseForm.paidAmount = String(item.price);
}
async function savePurchase() {
  if (!purchaseForm.memberId || !purchaseForm.planId || Number(purchaseForm.paidAmount) <= 0) return ElMessage.warning('请完整填写办理信息');
  if (!purchaseForm.requestKey) purchaseForm.requestKey = crypto.randomUUID();
  saving.value = true;
  try {
    await purchasePackage({ ...purchaseForm, paidAmount: Number(purchaseForm.paidAmount).toFixed(2) });
    ElMessage.success('套餐办理成功，收款已记入套餐台账');
    closePurchase();
    await loadAll();
  } finally { saving.value = false; }
}

async function redeem(row) {
  let note;
  try {
    const result = await ElMessageBox.prompt('可填写本次护理备注', `确认扣除「${row.planName}」1次？`, { inputPlaceholder: '例如：第1次护理（可不填）', confirmButtonText: '确认扣次', cancelButtonText: '取消' });
    note = result.value || '';
  } catch { return; }
  busyId.value = row.id;
  try {
    await redeemPackage(row.id, { requestKey: crypto.randomUUID(), note });
    ElMessage.success('已扣除1次');
    await loadAll();
  } finally { busyId.value = ''; }
}

async function reverseUsage(usage) {
  let reason;
  try {
    const result = await ElMessageBox.prompt('撤销后会恢复1次，请填写原因', '撤销扣次', { inputPlaceholder: '例如：员工误操作', inputValidator: value => Boolean(value?.trim()) || '必须填写原因', confirmButtonText: '确认撤销', cancelButtonText: '取消' });
    reason = result.value.trim();
  } catch { return; }
  await reversePackageUsage(usage.id, { reason });
  ElMessage.success('扣次已撤销，次数已恢复');
  await loadAll();
}

async function toggleStatus(row) {
  const status = row.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
  await setPackageStatus(row.id, status);
  ElMessage.success(status === 'ACTIVE' ? '次卡已恢复' : '次卡已暂停');
  await loadAll();
}

function openCloseout(row, action) {
  closeoutTarget.value = row;
  Object.assign(closeoutForm, {
    action, refundAmount: '', reason: '', approvedBy: '', requestKey: crypto.randomUUID(),
  });
  closeoutDialog.value = true;
}

async function saveCloseout() {
  if (!closeoutTarget.value) return;
  if (!closeoutForm.reason.trim() || !closeoutForm.approvedBy.trim()) return ElMessage.warning('请填写原因和审批人');
  const amount = Number(closeoutForm.refundAmount);
  if (closeoutForm.action === 'REFUND' && (!Number.isFinite(amount) || amount <= 0)) {
    return ElMessage.warning('请填写有效的退款金额');
  }
  const payload = {
    requestKey: closeoutForm.requestKey || crypto.randomUUID(),
    reason: closeoutForm.reason.trim(),
    approvedBy: closeoutForm.approvedBy.trim(),
  };
  if (closeoutForm.action === 'REFUND') payload.refundAmount = amount.toFixed(2);
  saving.value = true;
  try {
    if (closeoutForm.action === 'REFUND') {
      await refundPackage(closeoutTarget.value.id, payload);
    } else {
      await voidPackage(closeoutTarget.value.id, payload);
    }
    ElMessage.success(closeoutForm.action === 'REFUND' ? '套餐已退款，审计已记录' : '套餐已作废，审计已记录');
    closeoutDialog.value = false;
    await loadAll();
  } finally { saving.value = false; }
}

function openAudits(row) {
  auditTarget.value = row;
  auditDialog.value = true;
}

const expired = row => Boolean(row.expiresAt && new Date(row.expiresAt) <= new Date());
const isClosed = row => ['REFUNDED', 'VOID'].includes(row.status);
const canCloseout = row => !isClosed(row) && ['ACTIVE', 'PAUSED'].includes(row.status);
const canRedeem = row => row.status === 'ACTIVE' && row.remainingUses > 0 && !expired(row);
const statusText = row => row.status === 'REFUNDED' ? '已退款'
  : row.status === 'VOID' ? '已作废'
    : expired(row) ? '已过期'
      : row.remainingUses <= 0 ? '已用完'
        : row.status === 'ACTIVE' ? '可使用' : '已暂停';
const statusType = row => row.status === 'REFUNDED' ? 'danger'
  : row.status === 'VOID' ? 'info'
    : canRedeem(row) ? 'success'
      : row.status === 'PAUSED' ? 'warning' : 'info';
const formatDate = (value, dateOnly = false) => new Intl.DateTimeFormat('zh-CN', dateOnly ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

onMounted(loadAll);
</script>

<style scoped>
.package-page { display: grid; gap: 18px; }
.page-heading, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-heading h2 { margin: 0 0 6px; }
.page-heading p, .muted, small { color: #909399; margin: 0; }
.heading-actions { display: flex; }
.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.summary-grid :deep(.el-card__body) { display: flex; flex-direction: column; gap: 8px; }
.summary-grid strong { font-size: 26px; color: var(--el-color-primary); }
.usage-panel { padding: 12px 36px; max-width: 900px; }
.usage-title { font-weight: 600; margin-bottom: 12px; }
.audit-panel { margin-top: 22px; border-top: 1px dashed #e4e7ed; padding-top: 18px; }
small { display: block; margin: 4px 0; }
@media (max-width: 767px) {
  .page-heading, .toolbar { align-items: stretch; flex-direction: column; }
  .summary-grid { grid-template-columns: repeat(2, 1fr); }
  .heading-actions > * { flex: 1; }
}
</style>
