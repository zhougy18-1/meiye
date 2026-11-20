<template>
  <el-dialog v-model="visible" :title="form.id ? '编辑预约' : '新增预约'" width="600px" @closed="onDialogClosed">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
      <el-form-item label="姓名" prop="customerName">
        <el-autocomplete
          v-model="form.customerName"
          :fetch-suggestions="queryMembersAsync"
          placeholder="搜索会员或直接输入姓名，可不填"
          @select="handleMemberSelect"
          @change="handleCustomerNameChange"
          style="width: 100%"
          clearable
          @clear="clearMemberSelection"
        />
      </el-form-item>
      
      <el-form-item label="联系电话" prop="customerPhone">
        <el-input v-model="form.customerPhone" placeholder="请输入联系电话" :disabled="!!form.memberId" />
      </el-form-item>

      <el-form-item label="预约日期" prop="appointmentDate">
        <el-date-picker
          v-model="form.appointmentDate"
          type="date"
          placeholder="选择日期"
          style="width: 100%;"
          :disabled-date="disabledDate"
        />
      </el-form-item>
      
      <el-form-item label="预约时段" prop="appointmentTime">
         <el-select 
            v-model="form.appointmentTime" 
            placeholder="选择预约时段"
            style="width: 100%;"
          >
           <el-option 
              v-for="timeSlot in timeSlots" 
              :key="timeSlot.value" 
              :label="timeSlot.label" 
              :value="timeSlot.value"
            />
         </el-select>
         <!-- P0 缺口补齐：按「床位 × 时段」显示剩余可约，不改变 timeSlots / appointmentHour 交互。 -->
         <div v-if="capacityHint" class="capacity-hint">{{ capacityHint }}</div>
      </el-form-item>
      
      <el-form-item label="预约项目" prop="serviceIds">
        <el-select v-model="form.serviceIds" multiple filterable placeholder="选择服务项目" style="width: 100%">
          <el-option
            v-for="item in serviceList"
            :key="item.id"
            :label="item.name"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      
      <el-form-item label="服务员工" prop="assignedStaffId">
        <el-select v-model="form.assignedStaffId" placeholder="可不指定员工" style="width: 100%" clearable>
          <el-option
            v-for="item in staffList"
            :key="item.id"
            :label="`${item.name} (${item.position})`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>

      <!-- P0 缺口补齐：新老客 / 来源渠道 / 床位，全部可空（旧记录显示「未标注」）。 -->
      <el-form-item label="新老客" prop="customerType">
        <el-select v-model="form.customerType" placeholder="可不标注" style="width: 100%" clearable>
          <el-option v-for="item in customerTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>

      <el-form-item label="来源渠道" prop="sourceChannel">
        <el-select v-model="form.sourceChannel" placeholder="可不标注" style="width: 100%" clearable>
          <el-option v-for="item in sourceChannelOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>

      <el-form-item label="床位" prop="bedId">
        <el-select v-model="form.bedId" placeholder="可不指定床位" style="width: 100%" clearable>
          <el-option v-for="item in bedOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>

       <el-form-item label="备注" prop="notes">
        <el-input v-model="form.notes" type="textarea" placeholder="请输入备注" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="handleSubmit" :loading="loading">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted, computed, watch } from 'vue';

import { getMembers } from '@/api/member.js';
import { getServiceList } from '@/api/service.js';
import { getStaffList } from '@/api/staff.js';
import { createAppointment, getAppointmentCapacity } from '@/api/appointment.js';
// 展示镜像：渠道 / 新老客 / 床位选项集中取自 constants/p0Gap.js，业务判定以后端为准。
import { CUSTOMER_TYPE_OPTIONS, SOURCE_CHANNEL_OPTIONS, BED_OPTIONS } from '@/constants/p0Gap.js';
import { ElMessage } from 'element-plus';

const visible = ref(false);
const loading = ref(false);
const formRef = ref(null);
const serviceList = ref([]);
const staffList = ref([]);
const selectedMember = ref(null);
const capacity = ref(null);
const customerTypeOptions = CUSTOMER_TYPE_OPTIONS;
const sourceChannelOptions = SOURCE_CHANNEL_OPTIONS;
const bedOptions = BED_OPTIONS;

const getInitialForm = () => ({
  id: null,
  memberId: null,
  customerName: '',
  customerPhone: '',
  appointmentDate: null,
  appointmentTime: '',
  assignedStaffId: null,
  serviceIds: [],
  notes: '',
  // P0 缺口补齐：三个新字段，可空。
  customerType: null,
  sourceChannel: null,
  bedId: null,
});
const form = reactive(getInitialForm());

const rules = computed(() => ({
  customerPhone: [{ required: true, message: '请输入联系电话', trigger: 'blur' }],
  appointmentDate: [{ required: true, message: '请选择预约日期', trigger: 'change' }],
  appointmentTime: [{ required: true, message: '请选择预约时段', trigger: 'change' }],
  serviceIds: [{ required: true, message: '请至少选择一个服务项目', trigger: 'change' }],
}));

const emit = defineEmits(['success']);

onMounted(() => {
  fetchServicesAndStaff();
});

const fetchServicesAndStaff = async () => {
  try {
    const [services, staff] = await Promise.all([
      getServiceList({ status: 'AVAILABLE' }),
      // --- 核心修改：只获取在职的员工 ---
      getStaffList({ status: 'ACTIVE' }),
    ]);
    serviceList.value = services;
    staffList.value = staff;
  } catch {
    ElMessage.error('获取基础数据失败');
  }
};

const queryMembersAsync = async (queryString, cb) => {
  if (!queryString) return cb([]);
  const { data } = await getMembers({ search: queryString, limit: 20 });
  if (!data || data.length === 0) {
    cb([]);
    return;
  }
  cb(data.map(m => ({ ...m, value: `${m.name} (${m.phone || '手机号未填写'})` })));
};

const handleMemberSelect = (item) => {
  form.memberId = item.id;
  form.customerName = item.name;
  form.customerPhone = item.phone || '';
  selectedMember.value = item;
};

const handleCustomerNameChange = (value) => {
  if (selectedMember.value && value !== selectedMember.value.name) {
     clearMemberSelection();
     form.customerName = value;
  }
};

const clearMemberSelection = () => {
    form.memberId = null;
    selectedMember.value = null;
};

const toDateParam = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 日期变化时刷新该日「床位 × 时段」可约容量（接口失败不影响原有预约流程）。
watch(() => form.appointmentDate, async (value) => {
  if (!value) { capacity.value = null; return; }
  try {
    capacity.value = await getAppointmentCapacity(toDateParam(value));
  } catch {
    capacity.value = null;
  }
});

const capacityHint = computed(() => {
  if (!capacity.value || !form.appointmentTime) return '';
  const slot = capacity.value.slots?.find(item => item.slot === form.appointmentTime);
  if (!slot) return '';
  return `该时段剩余可约 ${slot.available} / ${slot.total}`;
});

const handleSubmit = async () => {
  await formRef.value.validate(async (valid) => {
    if (!valid) return;
    loading.value = true;
    try {
      const datePart = new Date(form.appointmentDate);
      const [hours, minutes] = form.appointmentTime.split(':');
      datePart.setHours(parseInt(hours, 10), parseInt(minutes, 10));

      const submissionData = { ...form, appointmentTime: datePart.toISOString() };
      delete submissionData.appointmentDate;
      delete submissionData.id;

await createAppointment(submissionData);
      // 核心：这里要使用 ElMessageBox.alert
ElMessage.success('新增预约成功'); // 使用 ElMessage.success

      visible.value = false;
      emit('success');
    } finally {
      loading.value = false;
    }
  });
};

const open = (initialDate = new Date()) => {
  form.appointmentDate = initialDate;
  visible.value = true;
};

const onDialogClosed = () => {
  Object.assign(form, getInitialForm());
  selectedMember.value = null;
  capacity.value = null;
  if(formRef.value) {
    formRef.value.clearValidate();
  }
};

const disabledDate = (time) => {
  return time.getTime() < Date.now() - 8.64e7;
};

const timeSlots = computed(() => {
  const slots = [];
  for (let h = 8; h < 22; h++) {
    const hour = h.toString().padStart(2, '0');
    slots.push({
      value: `${hour}:00`,
      label: `${hour}:00 - ${hour}:30`,
    });
    slots.push({
      value: `${hour}:30`,
      label: `${hour}:30 - ${(h + 1).toString().padStart(2, '0')}:00`,
    });
  }
  return slots;
});

defineExpose({ open });
</script>

<style scoped>
.capacity-hint { color: #909399; font-size: 12px; line-height: 1.6; margin-top: 4px; }
</style>
