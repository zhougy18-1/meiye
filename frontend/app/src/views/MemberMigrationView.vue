<template>
  <div class="migration-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">门店初始化</p>
        <h2>历史会员与权益迁移</h2>
        <p>先预览校验，再写入期初权益。历史金额不会计入导入日营业额。</p>
      </div>
      <el-button @click="downloadTemplate">下载正式模板</el-button>
    </div>

    <el-alert type="warning" :closable="false" show-icon title="请在闭店切换前确认统一统计截止时间，并把截止后的充值、消费、退款和核销更新到最终文件。" />

    <el-card class="workflow-card" shadow="never">
      <el-steps :active="activeStep" finish-status="success" align-center>
        <el-step title="选择文件" /><el-step title="权益映射" /><el-step title="校验预览" /><el-step title="正式导入" />
      </el-steps>

      <div class="form-grid">
        <el-form-item label="Excel 文件" required>
          <input ref="fileInput" class="file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="selectFile" />
          <div class="field-help">{{ selectedFile?.name || '请选择最终核实的 .xlsx 文件（不超过 5MB）' }}</div>
        </el-form-item>
        <el-form-item label="统计截止时间" required>
          <el-date-picker v-model="cutoffAt" type="datetime" placeholder="选择门店统一截止时间" style="width:100%" />
        </el-form-item>
        <el-form-item label="默认储值卡类型">
          <el-select v-model="cardTypeId" clearable placeholder="仅用于有余额且未单独指定的会员" style="width:100%">
            <el-option v-for="item in options.cardTypes" :key="item.id" :label="`${item.name}（${formatDiscount(item.discountRate)}）`" :value="item.id" />
          </el-select>
          <div class="field-help">会员等级只是分类标签，不会自动决定卡类型或折扣。</div>
        </el-form-item>
      </div>

      <div v-if="projectNames.length" class="mapping-section">
        <h3>护理项目映射</h3>
        <div v-for="project in projectNames" :key="project" class="mapping-row">
          <strong>{{ project }}</strong>
          <el-select v-model="projectMappings[project]" placeholder="明确选择现有套餐" style="width:360px">
            <el-option v-for="plan in options.plans" :key="plan.id" :label="`${plan.name} · ${plan.service?.name || ''}`" :value="plan.id" />
          </el-select>
        </div>
      </div>

      <div v-if="balanceMembers.length" class="mapping-section">
        <div class="section-heading"><h3>储值卡类型映射</h3><span>默认卡类型可统一覆盖；仅在会员卡类型不同时逐人指定</span></div>
        <el-table :data="balanceMembers" size="small" max-height="320">
          <el-table-column prop="externalId" label="会员编号" width="130" />
          <el-table-column prop="name" label="姓名" width="130" />
          <el-table-column prop="classification" label="分类标签" min-width="130" />
          <el-table-column prop="balance" label="期初余额" width="120"><template #default="{row}">¥{{ row.balance }}</template></el-table-column>
          <el-table-column label="卡类型" min-width="220"><template #default="{row}">
            <el-select v-model="cardTypeMappings[row.externalId]" clearable :placeholder="cardTypeId ? '使用默认卡类型' : '请选择卡类型'">
              <el-option v-for="item in options.cardTypes" :key="item.id" :label="`${item.name}（${formatDiscount(item.discountRate)}）`" :value="item.id" />
            </el-select>
          </template></el-table-column>
        </el-table>
      </div>

      <div class="actions">
        <el-button type="primary" :loading="previewing" :disabled="!selectedFile || !cutoffAt" @click="runPreview">解析并预览</el-button>
        <span class="field-help">上传和预览不会创建会员或改变权益。</span>
      </div>
    </el-card>

    <template v-if="preview">
      <div class="summary-grid">
        <el-card shadow="never"><span>会员</span><strong>{{ preview.summary.memberCount }}</strong></el-card>
        <el-card shadow="never"><span>期初余额</span><strong>¥{{ preview.summary.openingBalance }}</strong></el-card>
        <el-card shadow="never"><span>疗程记录</span><strong>{{ preview.summary.courseRecordCount }}</strong></el-card>
        <el-card shadow="never"><span>校验结果</span><strong :class="preview.canCommit ? 'ok' : 'bad'">{{ preview.canCommit ? '可提交' : '需处理' }}</strong></el-card>
      </div>

      <el-card shadow="never" class="issues-card">
        <div class="section-heading"><h3>校验结果</h3><span>错误 {{ errorIssues.length }} · 警告 {{ warningIssues.length }}</span></div>
        <el-empty v-if="!preview.issues.length" description="校验通过，没有发现异常" />
        <el-table v-else :data="preview.issues" size="small" max-height="360">
          <el-table-column label="级别" width="80"><template #default="{row}"><el-tag :type="row.severity === 'error' ? 'danger' : 'warning'">{{ row.severity === 'error' ? '错误' : '警告' }}</el-tag></template></el-table-column>
          <el-table-column prop="sheet" label="工作表" width="130" />
          <el-table-column label="位置" width="120"><template #default="{row}">{{ row.row ? `第 ${row.row} 行` : '-' }} {{ row.field }}</template></el-table-column>
          <el-table-column prop="message" label="原因及处理建议" min-width="300" />
        </el-table>
        <div v-if="warningCodes.length && !errorIssues.length" class="acknowledge">
          <el-checkbox v-model="acknowledged">我已逐项核实以上警告，确认按预览结果建立期初数据</el-checkbox>
        </div>
        <div class="actions">
          <el-button type="primary" :disabled="!preview.canCommit || (warningCodes.length > 0 && !acknowledged)" :loading="committing" @click="commit">确认正式导入</el-button>
          <span class="field-help">正式提交后将创建会员、可用余额和可核销疗程；不会创建当日收款。</span>
        </div>
      </el-card>
    </template>

    <el-card shadow="never" class="history-card">
      <div class="section-heading"><h3>迁移批次</h3><el-button link @click="loadBatches">刷新</el-button></div>
      <el-table :data="batches" v-loading="loadingBatches" empty-text="还没有迁移批次">
        <el-table-column prop="fileName" label="文件" min-width="220" show-overflow-tooltip />
        <el-table-column label="截止时间" width="180"><template #default="{row}">{{ formatDate(row.cutoffAt) }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{row}"><el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="会员/余额" min-width="150"><template #default="{row}">{{ row.previewSummary?.memberCount || 0 }} 人 · ¥{{ row.previewSummary?.openingBalance || '0.00' }}</template></el-table-column>
        <el-table-column prop="createdByName" label="操作人" width="110" />
        <el-table-column label="操作" width="210"><template #default="{row}"><el-button link @click="downloadReport(row)">下载报告</el-button><el-button v-if="row.status === 'COMMITTED'" link type="danger" @click="rollback(row)">安全回滚</el-button></template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { commitMigration, downloadMigrationReport, downloadMigrationTemplate, getMigrationBatches, getMigrationOptions, previewMigration, rollbackMigration } from '@/api/memberMigration.js';

const options = reactive({ cardTypes: [], plans: [] });
const selectedFile = ref(null); const cutoffAt = ref(null); const cardTypeId = ref('');
const projectMappings = reactive({}); const cardTypeMappings = reactive({}); const projectNames = ref([]); const preview = ref(null);
const previewing = ref(false); const committing = ref(false); const loadingBatches = ref(false); const batches = ref([]); const acknowledged = ref(false);
const errorIssues = computed(() => preview.value?.issues.filter(i => i.severity === 'error') || []);
const warningIssues = computed(() => preview.value?.issues.filter(i => i.severity === 'warning') || []);
const warningCodes = computed(() => [...new Set(warningIssues.value.map(i => i.code))]);
const balanceMembers = computed(() => {
  const members = new Map((preview.value?.snapshot?.members || []).map(member => [member.externalId, member]));
  return (preview.value?.snapshot?.balances || []).filter(row => Number(row.balance) > 0).map(row => ({ ...members.get(row.externalId), ...row }));
});
const activeStep = computed(() => preview.value ? (preview.value.status === 'COMMITTED' ? 4 : 3) : (projectNames.value.length ? 2 : selectedFile.value ? 1 : 0));

onMounted(async () => { const data = await getMigrationOptions(); Object.assign(options, data); await loadBatches(); });
function selectFile(event) { selectedFile.value = event.target.files?.[0] || null; preview.value = null; projectNames.value = []; acknowledged.value = false; Object.keys(projectMappings).forEach(key => delete projectMappings[key]); Object.keys(cardTypeMappings).forEach(key => delete cardTypeMappings[key]); }
function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }
async function runPreview() {
  previewing.value = true;
  try {
    const data = await previewMigration({ fileName: selectedFile.value.name, fileBase64: await fileBase64(selectedFile.value), cutoffAt: cutoffAt.value.toISOString(), cardTypeId: cardTypeId.value || null, cardTypeMappings: Object.fromEntries(Object.entries(cardTypeMappings).filter(([,v]) => v)), projectMappings: Object.fromEntries(Object.entries(projectMappings).filter(([,v]) => v)) });
    preview.value = data; acknowledged.value = false;
    projectNames.value = [...new Set((data.snapshot?.courses || []).map(row => row.project))];
    if (data.issues.some(issue => issue.code === 'PACKAGE_PLAN_MAPPING_REQUIRED')) ElMessage.warning('请完成护理项目映射后再次解析预览');
  } finally { previewing.value = false; }
}
async function commit() {
  await ElMessageBox.confirm(`将创建 ${preview.value.summary.memberCount} 名会员和对应期初权益，确认继续？`, '确认正式导入', { type: 'warning', confirmButtonText: '确认导入' });
  committing.value = true;
  try { await commitMigration(preview.value.id, warningCodes.value); ElMessage.success('历史会员与期初权益导入完成'); preview.value.status = 'COMMITTED'; await loadBatches(); }
  finally { committing.value = false; }
}
async function rollback(row) {
  const { value } = await ElMessageBox.prompt('仅未发生后续交易、预约、余额或次数变化的批次可回滚。请输入原因：', '安全回滚', { inputPattern: /\S+/, inputErrorMessage: '请填写回滚原因', confirmButtonText: '检查并回滚', type: 'warning' });
  await rollbackMigration(row.id, value); ElMessage.success('该批次已安全回滚并保留审计记录'); await loadBatches();
}
async function loadBatches() { loadingBatches.value = true; try { batches.value = await getMigrationBatches(); } finally { loadingBatches.value = false; } }
async function downloadTemplate() { const blob = await downloadMigrationTemplate(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '青司系统_M77会员资料导入模板.xlsx'; a.click(); URL.revokeObjectURL(url); }
async function downloadReport(row) { const blob = await downloadMigrationReport(row.id); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `M77会员迁移对账报告-${row.id}.xlsx`; a.click(); URL.revokeObjectURL(url); }
const formatDate = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) : '-';
const formatDiscount = value => `${Number((Number(value) * 10).toFixed(2))}折`;
const statusText = value => ({ PREVIEW:'待提交', COMMITTING:'处理中', COMMITTED:'已导入', ROLLING_BACK:'回滚中', ROLLED_BACK:'已回滚' }[value] || value);
const statusType = value => ({ PREVIEW:'warning', COMMITTED:'success', ROLLED_BACK:'info' }[value] || 'warning');
</script>

<style scoped>
.migration-page{display:flex;flex-direction:column;gap:18px}.page-heading,.section-heading,.mapping-row,.actions{display:flex;align-items:center;justify-content:space-between;gap:18px}.page-heading h2,.section-heading h3{margin:0;color:var(--brand-text,#302d28)}.page-heading p{margin:6px 0 0;color:var(--brand-text-secondary,#827c73)}.eyebrow{font-size:13px!important;letter-spacing:.14em;color:var(--el-color-primary)!important}.workflow-card{border-color:var(--brand-border,#eae6df)}.form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;margin-top:30px}.file-input{width:100%;padding:9px;border:1px solid var(--brand-border,#eae6df);border-radius:6px;background:#fff}.field-help{font-size:13px;color:var(--brand-text-secondary,#827c73);margin-top:6px}.mapping-section{border-top:1px solid var(--brand-border,#eae6df);margin-top:12px;padding-top:16px}.mapping-row{justify-content:flex-start;padding:7px 0}.mapping-row strong{width:200px}.actions{justify-content:flex-start;margin-top:20px}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.summary-grid .el-card span{display:block;color:var(--brand-text-secondary,#827c73);font-size:14px}.summary-grid strong{display:block;margin-top:9px;font-size:25px;color:var(--brand-text,#302d28)}.summary-grid .ok{color:#39765a}.summary-grid .bad{color:#b54545}.section-heading{margin-bottom:14px}.section-heading span{color:var(--brand-text-secondary,#827c73)}.acknowledge{margin-top:16px;padding:14px;background:#faf7f0;border-radius:8px}.history-card{margin-bottom:20px}@media(max-width:900px){.form-grid,.summary-grid{grid-template-columns:1fr 1fr}}@media(max-width:640px){.page-heading,.mapping-row{align-items:flex-start;flex-direction:column}.form-grid,.summary-grid{grid-template-columns:1fr}.mapping-row strong,.mapping-row .el-select{width:100%!important}}
</style>
