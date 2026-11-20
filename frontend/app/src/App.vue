<template>
  <div v-if="demoMessage" class="demo-banner">{{ demoMessage }}</div>
  <div v-if="!isPublicPage" class="app-wrapper">
    <!-- 统一的顶部导航栏 -->
    <el-header class="app-header">
      <div class="header-content">
        <!-- Logo容器 -->
        <div class="logo-container" :aria-label="appConfig.brandName">
          <span class="brand-image-crop" role="img" :aria-label="`${appConfig.brandName} 原始品牌标识`"></span>
          <span class="logo-copy">
            <strong>{{ appConfig.brandName }}</strong>
            <small>{{ appConfig.englishName }} · {{ appConfig.systemName }}</small>
          </span>
        </div>
        
        <!-- PC端导航 -->
        <div class="header-right pc-nav">
          <nav class="custom-nav">
            <router-link
              v-for="item in filteredMenuItems"
              :key="item.index"
              :to="item.index"
              class="nav-item"
              active-class="is-active"
              @click="handleNavClick(item.index)"
            >
              <el-badge 
                :value="systemStore.todayAppointmentCount" 
                :hidden="systemStore.todayAppointmentCount === 0" 
                class="nav-badge"
                v-if="item.index === '/appointments'"
              >
                <div class="nav-item-content">
                  <el-icon><component :is="item.icon" /></el-icon>
                  <span>{{ item.title }}</span>
                </div>
              </el-badge>
              <el-badge 
                is-dot
                :hidden="!showBirthdayBadge"
                type="warning"
                class="nav-badge"
                v-else-if="item.index === '/reports'"
              >
                <div class="nav-item-content">
                  <el-icon><component :is="item.icon" /></el-icon>
                  <span>{{ item.title }}</span>
                </div>
              </el-badge>
              <div class="nav-item-content" v-else>
                <el-icon><component :is="item.icon" /></el-icon>
                <span>{{ item.title }}</span>
              </div>
            </router-link>
          </nav>

          <div v-if="userStore.isLoggedIn" class="user-profile">
             <el-dropdown @command="handleUserCommand" trigger="click">
              <span class="el-dropdown-link">
                <el-avatar :icon="UserFilled" size="small" />
                <span class="username">{{ userStore.userInfo?.username || '用户' }}</span>
                <el-icon class="el-icon--right"><arrow-down /></el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item class="font-size-adjuster-item" :divided="true">
                    <div class="font-size-adjuster-wrapper">
                      <span class="adjuster-label">字体大小</span>
                      <el-radio-group 
                        :model-value="uiStore.fontSize"
                        @update:model-value="handleFontCommand" 
                        size="small"
                      >
                        <!-- 核心修复：将 label 改为 value -->
                        <el-radio-button value="default">默认</el-radio-button>
                        <el-radio-button value="medium">中</el-radio-button>
                        <el-radio-button value="large">大</el-radio-button>
                      </el-radio-group>
                    </div>
                  </el-dropdown-item>
                  <el-dropdown-item command="logout" :divided="true">退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <!-- 移动端UI -->
         <div class="header-right mobile-only">
            <div v-if="userStore.isLoggedIn" class="user-profile">
                <el-dropdown @command="handleUserCommand">
                <span class="el-dropdown-link">
                    <el-avatar :icon="UserFilled" size="small" />
                    <span class="username">{{ userStore.userInfo?.username || '用户' }}</span>
                </span>
                <template #dropdown>
                    <el-dropdown-menu>
                    <el-dropdown-item command="logout">退出登录</el-dropdown-item>
                    </el-dropdown-menu>
                </template>
                </el-dropdown>
            </div>
        </div>
      </div>
    </el-header>

    <!-- 主体内容区域 -->
    <main class="app-main">
      <div class="main-content-wrapper">
        <el-alert
          v-if="route.name === 'reports'"
          class="report-accounting-note"
          type="warning"
          :closable="false"
          title="套餐收入使用独立台账，当前未计入本页原收银报表。请到“套餐”页面查看套餐实收与核销次数。"
        />
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <div class="page-container" v-if="Component">
              <component :is="Component" />
            </div>
          </transition>
        </router-view>
      </div>
    </main>
    
    <!-- 移动端底部导航栏 -->
    <footer class="mobile-nav">
       <router-link
            v-for="item in filteredMenuItems"
            :key="item.index"
            :to="item.index"
            class="nav-item"
            active-class="is-active"
          >
            <el-badge 
              :value="systemStore.todayAppointmentCount" 
              :hidden="systemStore.todayAppointmentCount === 0" 
              class="nav-badge-mobile"
              v-if="item.index === '/appointments'"
            >
              <div class="nav-item-content-mobile">
                <el-icon><component :is="item.icon" /></el-icon>
                <span>{{ item.title }}</span>
              </div>
            </el-badge>
            <div class="nav-item-content-mobile" v-else>
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.title }}</span>
            </div>
        </router-link>
    </footer>
  </div>
  
  <router-view v-else />
</template>

<script setup>
import { shallowRef, computed, onMounted, watch, ref } from 'vue';
import { useUserStore } from '@/stores/user';
import { useSystemStore } from '@/stores/system';
import { useUIStore } from '@/stores/ui';
import { useRoute } from 'vue-router';
import { User, UserFilled, ArrowDown, Money, Calendar, PieChart, Operation, Tickets, ChatDotRound, UploadFilled } from '@element-plus/icons-vue';
import appConfig from '@/config/app.js';

const userStore = useUserStore();
const systemStore = useSystemStore();
const uiStore = useUIStore();
const route = useRoute();
// 演示文字只在显式注入时出现；正式构建不传该变量，因此生产产物不会包含演示提示。
const demoMessage = import.meta.env.VITE_DEMO_MESSAGE || '';
const isDemoMode = computed(() => Boolean(demoMessage));

const showBirthdayBadge = ref(false);
const isPublicPage = computed(() => ['login', 'booking'].includes(route.name));

const fetchAllReminders = () => {
  systemStore.fetchTodayAppointmentCount();
  if (userStore.userRole === 'ADMIN') systemStore.fetchUpcomingBirthdayCount();
};

onMounted(() => {
  if (!isPublicPage.value) {
    document.title = appConfig.fullTitle;
  }
  if (userStore.isLoggedIn) {
    fetchAllReminders();
  }
  applyFontSize(uiStore.fontSize);
});

watch(() => systemStore.upcomingBirthdayCount, (newCount) => {
    if (newCount > 0) {
        showBirthdayBadge.value = true;
    }
});

watch(() => userStore.isLoggedIn, (isLoggedIn) => {
    if (isLoggedIn) {
        fetchAllReminders();
    }
});

const menuItems = shallowRef([
  { index: '/transactions', title: '收银', icon: Money },
  { index: '/members', title: '会员', icon: User },
  { index: '/appointments', title: '预约', icon: Calendar },
  { index: '/packages', title: '套餐', icon: Tickets, roles: ['ADMIN'] },
  { index: '/sms-notifications', title: '短信', icon: ChatDotRound, roles: ['ADMIN'] },
  { index: '/reports', title: '报表', icon: PieChart, roles: ['ADMIN'] },
  { index: '/member-migrations', title: '迁移', icon: UploadFilled, roles: ['ADMIN'] },
  { index: '/settings', title: '设置', icon: Operation, roles: ['ADMIN'] },
]);

const filteredMenuItems = computed(() => {
  const userRole = userStore.userRole;
  if (!userRole) {
    return [];
  }
  return menuItems.value.filter(item => {
    return !item.roles || item.roles.includes(userRole);
  });
});

const handleUserCommand = (command) => {
  if (command === 'logout') {
    userStore.logout();
  }
};

const handleNavClick = (path) => {
    if (path === '/reports') {
        showBirthdayBadge.value = false;
    }
};

const fontSizeMap = {
  default: { base: '15px', tag: '13px' },
  medium:  { base: '16px', tag: '14px' },
  large:   { base: '17px', tag: '15px' },
};

const handleFontCommand = (newSize) => {
  uiStore.setFontSize(newSize);
};

const applyFontSize = (size) => {
  const sizes = fontSizeMap[size] || fontSizeMap['default'];
  const root = document.documentElement;
  root.style.setProperty('--el-font-size-base', sizes.base);
  root.style.setProperty('--dynamic-tag-font-size', sizes.tag);
};

watch(() => uiStore.fontSize, (newSize) => {
  applyFontSize(newSize);
});
</script>

<style scoped>
.app-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.demo-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 34px;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  color: #8a4b08;
  background: #fff3cd;
  border-bottom: 1px solid #f3d48a;
  font-size: 13px;
  font-weight: 600;
}
.app-header {
  background: rgba(255, 255, 255, .96);
  height: 68px;
  width: 100%;
  padding: 0;
  flex-shrink: 0;
  position: fixed;
  top: v-bind("isDemoMode ? '34px' : '0px'");
  left: 0;
  z-index: 1000;
  border-bottom: 1px solid var(--brand-border);
  backdrop-filter: blur(12px);
}
.header-content {
  max-width: 1400px;
  height: 100%;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  align-items: center;
}
/* 空间不够时先压缩 logo，否则右侧用户区会被顶出窗口外点不到 */
.logo-container { display: flex; align-items: center; gap: 12px; min-width: 290px; overflow: hidden; }
.brand-image-crop {
  width: 138px;
  height: 30px;
  flex: 0 0 138px;
  background-image: url('/images/m77-brand-reference.png');
  background-repeat: no-repeat;
  background-size: 245px auto;
  background-position: -18px -23px;
  mix-blend-mode: multiply;
}
.logo-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.logo-copy strong {
  color: var(--brand-ink);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: .08em;
  white-space: nowrap;
}
.logo-copy small {
  color: var(--brand-emphasis);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 9px;
  letter-spacing: .08em;
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 25px;
  margin-left: auto;
  flex-shrink: 0;
}
.custom-nav { display: flex; align-items: center; height: 100%; }
.nav-item {
  display: flex;
  align-items: center;
  padding: 0 12px;
  height: 100%;
  color: #625d56;
  text-decoration: none;
  font-size: 1rem;
  transition: all 0.2s ease;
  border-bottom: 3px solid transparent;
  position: relative; 
  margin-right: 12px;
}
.nav-item .el-icon {
  font-size: 1.2em;
  margin-right: 6px;
}
.nav-item:hover { color: var(--el-color-primary); }
.nav-item.is-active { color: var(--brand-emphasis); border-bottom-color: var(--brand-primary); font-weight: 600; }

.el-dropdown-link {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #606266;
}
.username {
  margin: 0 8px 0 0;
}

.app-main {
  flex-grow: 1;
  padding-top: v-bind("isDemoMode ? '102px' : '68px'");
  background:
    radial-gradient(circle at 0 0, rgba(214, 179, 95, .07), transparent 26%),
    var(--brand-canvas);
  overflow-y: auto;
}
.main-content-wrapper {
  padding: 24px;
}
.report-accounting-note { max-width: 1400px; margin: 0 auto 14px; }
.page-container {
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
  background-color: #fff;
  border: 1px solid var(--brand-border);
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(48, 45, 40, .055);
  padding: 24px;
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.mobile-nav, .mobile-only {
    display: none;
}

.nav-item-content, .nav-item-content-mobile {
  display: flex;
  align-items: center;
  justify-content: center;
}
.nav-item-content-mobile {
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.nav-badge, .nav-badge-mobile {
  width: 100%;
  height: 100%;
}
.nav-badge {
  display: flex;
  justify-content: center;
  align-items: center;
}

.font-size-adjuster-item {
  height: auto !important;
  background-color: transparent !important;
  cursor: default !important;
  padding: 8px 12px !important;
}
.font-size-adjuster-wrapper {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.adjuster-label {
  color: var(--el-text-color-regular);
}

@media (max-width: 767px) {
  .pc-nav { display: none !important; }
  .mobile-only { display: flex; margin-left: auto; }
  
  .header-content {
      justify-content: space-between;
  }
  .logo-copy { display: none; }
  .logo-container { min-width: auto; }
  .brand-image-crop { width: 112px; flex-basis: 112px; background-size: 200px auto; background-position: -15px -18px; }
  
  .app-main {
    padding: v-bind("isDemoMode ? '117px 15px 75px' : '83px 15px 75px'");
  }
  .main-content-wrapper { padding: 0; }
  .page-container { padding: 15px; border-radius: 6px;}

  .mobile-nav {
      display: flex;
      position: fixed;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 60px;
      background-color: rgba(255, 255, 255, .98);
      box-shadow: 0 -4px 18px rgba(48, 45, 40, .07);
      z-index: 1000;
      border-top: 1px solid var(--brand-border);
      overflow-x: auto;
  }
  .mobile-nav .nav-item {
      flex: 1;
      min-width: 54px;
      padding: 0 5px;
      font-size: 12px;
      line-height: 1.2;
      border-bottom-width: 2px;
  }
  .mobile-nav .nav-item .el-icon {
      margin-right: 0;
      margin-bottom: 2px;
      font-size: 20px;
  }
}
</style>

<style>
/* 全局样式 */
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--brand-canvas); }
body { margin: 0; font-family: Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif; }

.page-header {
  border-bottom-color: var(--brand-border) !important;
}
.page-title {
  color: var(--brand-ink) !important;
  font-weight: 650 !important;
  letter-spacing: .02em;
}
.filter-container,
.table-container {
  border-color: var(--brand-border) !important;
}

#nprogress .bar {
  background: var(--el-color-primary) !important;
  height: 3px !important;
}

#nprogress .peg {
  box-shadow: 0 0 10px var(--el-color-primary), 0 0 5px var(--el-color-primary) !important;
}

.el-dropdown-menu .el-radio-group {
  display: flex;
  width: 100%;
}
.el-dropdown-menu .el-radio-button {
  flex: 1;
}
.el-dropdown-menu .el-radio-button .el-radio-button__inner {
  width: 100%;
  padding: 6px;
}

body .el-tag {
  font-size: var(--dynamic-tag-font-size, 12px) !important;
}

/* 撤销确认对话框按钮位置交换 */
.el-message-box.void-confirm-dialog .el-message-box__btns {
  display: flex !important;
  flex-direction: row-reverse !important;
  justify-content: flex-start !important;
  gap: 12px !important;
}
.el-message-box.void-confirm-dialog .el-message-box__btns .el-button {
  margin: 0 !important;
}

/* 响应式弹窗 - 移动端自适应宽度 */
@media (max-width: 768px) {
  .el-dialog {
    --el-dialog-width: calc(100vw - 40px) !important;
    width: calc(100vw - 40px) !important;
    max-width: calc(100vw - 40px) !important;
    margin: 20px auto !important;
  }
  .el-dialog__body {
    padding: 15px !important;
  }
}
</style>
