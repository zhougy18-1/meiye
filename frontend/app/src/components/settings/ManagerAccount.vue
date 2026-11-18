<template>
  <div class="manager-account">
    <p>店长登录账号：{{ username || '读取中…' }}</p>
    <el-alert title="重设密码后，店长已登录的设备需要重新登录。" type="info" :closable="false" />
    <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" class="password-form">
      <el-form-item label="老板当前密码" prop="ownerPassword">
        <el-input v-model="form.ownerPassword" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="店长新密码" prop="newPassword">
        <el-input v-model="form.newPassword" type="password" show-password autocomplete="new-password" />
      </el-form-item>
      <el-form-item label="再次输入" prop="confirmPassword">
        <el-input v-model="form.confirmPassword" type="password" show-password autocomplete="new-password" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="submit">更新店长密码</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getManagerAccount, resetManagerPassword } from '@/api/user.js';

const username = ref('');
const saving = ref(false);
const formRef = ref(null);
const form = reactive({ ownerPassword: '', newPassword: '', confirmPassword: '' });
const rules = {
  ownerPassword: [{ required: true, message: '请输入老板当前密码', trigger: 'blur' }],
  newPassword: [{ required: true, min: 10, message: '店长新密码至少 10 位', trigger: 'blur' }],
  confirmPassword: [{
    validator: (_, value, callback) => {
      if (!value) callback(new Error('请再次输入店长新密码'));
      else if (value !== form.newPassword) callback(new Error('两次输入不一致'));
      else callback();
    }, trigger: 'blur',
  }],
};

onMounted(async () => {
  try { username.value = (await getManagerAccount()).username; } catch { /* API reports errors */ }
});

async function submit() {
  if (!formRef.value) return;
  try { await formRef.value.validate(); } catch { return; }
  saving.value = true;
  try {
    await resetManagerPassword({ ownerPassword: form.ownerPassword, newPassword: form.newPassword });
    form.ownerPassword = '';
    form.newPassword = '';
    form.confirmPassword = '';
    ElMessage.success('店长密码已更新');
  } catch {
    // The shared API interceptor displays the server error.
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.manager-account { max-width: 560px; padding-top: 12px; }
.password-form { margin-top: 22px; }
</style>
