<template>
  <main class="login-page-wrapper">
    <section class="login-container" aria-labelledby="login-heading">
      <div class="login-promo" aria-label="M.77 美肤空间品牌展示">
        <div class="brand-line" aria-hidden="true"></div>
        <img
          :src="appConfig.brandReference"
          :alt="`${appConfig.brandName} ${appConfig.englishName} 原始品牌标识`"
          class="brand-reference"
        />
        <div class="brand-copy">
          <p class="english-name">{{ appConfig.englishName }}</p>
          <h1>{{ appConfig.brandName }}</h1>
          <p class="brand-slogan">{{ appConfig.slogan }}</p>
        </div>
        <div class="promo-corner" aria-hidden="true"></div>
      </div>

      <div class="login-form-section">
        <div class="form-wrapper">
          <div class="mobile-brand" aria-hidden="true">
            <span>M.77</span>
            <small>{{ appConfig.englishName }}</small>
          </div>
          <div class="form-heading">
            <p class="form-eyebrow">{{ appConfig.systemName }}</p>
            <h2 id="login-heading" class="form-title">欢迎回来</h2>
            <p class="form-subtitle">登录您的门店经营管理工作台</p>
          </div>
          <el-form ref="formRef" :model="form" :rules="rules" @keyup.enter="handleLogin" label-position="top" aria-label="账号登录">
            <el-form-item prop="username" label="账号">
              <el-input v-model="form.username" placeholder="请输入账号" size="large" :prefix-icon="User" autocomplete="username" />
            </el-form-item>
            <el-form-item prop="password" label="密码">
              <el-input v-model="form.password" type="password" placeholder="请输入密码" size="large" show-password :prefix-icon="Lock" autocomplete="current-password" />
            </el-form-item>
            
            <el-form-item v-if="loginConfig.showCaptcha" prop="captchaText" label="验证码">
              <div class="captcha-wrapper">
                <el-input v-model="form.captchaText" placeholder="请输入验证码" size="large" />
                <button v-if="captchaImage" type="button" class="captcha-button" title="点击刷新验证码" @click="refreshCaptcha">
                  <img :src="captchaImage" class="captcha-image" alt="验证码图片，点击刷新" />
                </button>
              </div>
            </el-form-item>

            <el-form-item>
              <el-checkbox v-model="trustDevice" label="信任此设备（7天内免登录）" size="large" />
            </el-form-item>
            
            <el-form-item>
              <el-button type="primary" native-type="button" size="large" @click="handleLogin" :loading="loading" class="login-button">
                登录
              </el-button>
            </el-form-item>
          </el-form>
          <p class="powered-by">Powered by {{ appConfig.platformName }}</p>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { User, Lock } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { getSystemConfig } from '@/api/config.js';
import appConfig from '@/config/app.js';

const loginConfig = reactive({
  showCaptcha: true,
});

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();
const formRef = ref(null);
const loading = ref(false);
const captchaImage = ref('');
const trustDevice = ref(false);

const form = reactive({
  username: '',
  password: '',
  captchaText: '',
});

const rules = computed(() => ({
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  captchaText: loginConfig.showCaptcha 
    ? [{ required: true, message: '请输入验证码', trigger: 'blur' }]
    : []
}));

const refreshCaptcha = () => {
  captchaImage.value = `/api/auth/captcha?t=${new Date().getTime()}`;
};

onMounted(async () => {
  document.title = appConfig.fullTitle;
  // 先尝试获取系统配置
  try {
    const config = await getSystemConfig();
    loginConfig.showCaptcha = config.enableLoginCaptcha;
    console.log('验证码配置:', loginConfig.showCaptcha ? '开启' : '关闭');
  } catch {
    console.log('获取系统配置失败，使用默认配置');
    loginConfig.showCaptcha = true; // 默认显示验证码
  }
  
  // 如果需要显示验证码，则加载验证码图片
  if (loginConfig.showCaptcha) {
    refreshCaptcha();
  }
});

const handleLogin = async () => {
  if (!formRef.value) return;
  await formRef.value.validate(async (valid) => {
    if (!valid) return;
    loading.value = true;
    try {
      const loginPayload = {
        ...form,
        trustDevice: trustDevice.value
      };
      await userStore.login(loginPayload);

      ElMessage.success('登录成功！');
      router.replace(route.query.redirect || '/'); 
    } catch {
      refreshCaptcha();
      form.captchaText = '';
    } finally {
      loading.value = false;
    } 
  });
};
</script>

<style scoped>
.login-page-wrapper {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: clamp(20px, 4vw, 56px);
  background:
    radial-gradient(circle at 15% 12%, rgba(214, 179, 95, .12), transparent 28%),
    linear-gradient(145deg, #f7f3eb 0%, #faf9f6 42%, #f3eee5 100%);
}

.login-container {
  display: grid;
  grid-template-columns: minmax(360px, 1.08fr) minmax(380px, .92fr);
  width: min(1040px, 100%);
  min-height: 620px;
  background: rgba(255, 255, 255, .96);
  border: 1px solid rgba(149, 115, 51, .14);
  border-radius: 24px;
  box-shadow: 0 28px 80px rgba(61, 52, 38, .13);
  overflow: hidden;
}

.login-promo {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 30px;
  padding: clamp(52px, 7vw, 88px);
  color: var(--brand-ink);
  background: #f6f3ed;
  isolation: isolate;
}
.login-promo::before {
  content: '';
  position: absolute;
  inset: 32px 28px 32px 0;
  border: 1px solid rgba(149, 115, 51, .24);
  border-left: 0;
  border-radius: 0 0 92px 0;
  pointer-events: none;
  z-index: -1;
}
.brand-line {
  width: 72px;
  height: 2px;
  background: var(--brand-primary);
}
.brand-reference {
  display: block;
  width: 100%;
  max-width: 470px;
  aspect-ratio: 2048 / 1075;
  object-fit: contain;
  mix-blend-mode: multiply;
}
.brand-copy { max-width: 460px; }
.brand-copy h1 {
  margin: 8px 0 14px;
  font-size: clamp(26px, 3vw, 38px);
  font-weight: 500;
  letter-spacing: .14em;
}
.english-name {
  margin: 0;
  color: var(--brand-emphasis);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 13px;
  letter-spacing: .28em;
}
.brand-slogan {
  margin: 0;
  color: var(--brand-muted);
  font-size: 15px;
  line-height: 1.8;
  letter-spacing: .06em;
}

.login-form-section {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: clamp(44px, 6vw, 76px);
  background: var(--brand-surface);
}
.form-wrapper {
  width: 100%;
  max-width: 370px;
}
.form-heading { margin-bottom: 34px; }
.form-eyebrow {
  margin: 0 0 10px;
  color: var(--brand-emphasis);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .16em;
}
.form-title {
  margin: 0;
  color: var(--brand-ink);
  font-size: 30px;
  font-weight: 600;
  letter-spacing: .03em;
}
.form-subtitle {
  margin: 10px 0 0;
  color: var(--brand-muted);
  font-size: 14px;
  line-height: 1.6;
}

.captcha-wrapper {
  display: flex;
  width: 100%;
  gap: 10px;
}
.captcha-button {
  flex: 0 0 118px;
  height: 40px;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  background: #fff;
  border: 1px solid var(--brand-border);
  border-radius: 8px;
}
.captcha-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.login-button {
  width: 100%;
  min-height: 44px;
  letter-spacing: .3em;
}
.powered-by {
  margin: 10px 0 0;
  color: #a19a90;
  font-size: 12px;
  text-align: center;
  letter-spacing: .06em;
}
.mobile-brand { display: none; }

:deep(.el-form-item__label) {
  color: #4b4741;
  font-size: 14px;
  font-weight: 600;
}
:deep(.el-input__wrapper) { min-height: 44px; }
:deep(.el-checkbox__label) { color: var(--brand-muted); }

@media (max-width: 860px) {
  .login-container {
    grid-template-columns: 1fr;
    width: min(500px, 100%);
    min-height: auto;
  }
  .login-promo { display: none; }
  .login-form-section { padding: 42px clamp(24px, 7vw, 48px); }
  .mobile-brand {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 38px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--brand-border);
    color: var(--brand-emphasis);
  }
  .mobile-brand span { font: 34px/1 Georgia, 'Times New Roman', serif; }
  .mobile-brand small { font: 10px/1.2 Georgia, 'Times New Roman', serif; letter-spacing: .18em; }
}

@media (max-width: 480px) {
  .login-page-wrapper { place-items: start center; padding: 0; background: var(--brand-surface); }
  .login-container {
    width: 100%;
    min-height: 100vh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .login-form-section { align-items: flex-start; padding: 34px 24px; }
  .form-title { font-size: 27px; }
  .captcha-button { flex-basis: 104px; }
}
</style>
