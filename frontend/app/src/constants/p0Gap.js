// frontend/app/src/constants/p0Gap.js
// P0 缺口补齐「前端展示镜像」：仅提供下拉选项、标签与文案，非权威。
// 业务判定一律以后端 backend/app/src/config/p0GapPolicies.js 为准。
// ---------------------------------------------------------------------------
// 以下取值均为「依赖待决 Q-xx，当前采用建议默认值，待经营者确认后可调整」；
// 经营者确认后须与后端 p0GapPolicies.js 同步修改，禁止在视图中散落硬编码魔数。
// Q-01~Q-12 逐条归属（后端 12 项齐全且为唯一权威，本文件仅镜像展示相关项）：
//   Q-01 退款/作废区别 —— 后端权威；本文件仅镜像 REFUNDED/VOID 标签。
//   Q-02 部分退款上限 —— 后端权威（computeRefundCap）；前端不参与金额判定。
//   Q-03 剩余次数归零 —— 后端权威；前端仅展示「剩余次数归零」文案。
//   Q-04 不写旧 Transaction —— 后端权威；前端不展示。
//   Q-05 新老客判定 —— 后端权威；本文件镜像 CUSTOMER_TYPE_OPTIONS/LABELS。
//   Q-06 来源渠道 7 项 —— 后端权威；本文件镜像 SOURCE_CHANNEL_OPTIONS/LABELS。
//   Q-07 床位 B1–B4 与容量算法 —— 后端权威；本文件镜像 BED_OPTIONS。
//   Q-08 报表时间口径 —— 后端权威；前端只展示返回的三个并列字段。
//   Q-09 回执终态命名 —— 后端权威；本文件镜像 SMS_STATUS_* 八态标签。
//   Q-10 演示四级账号 —— 后端权威（init-admin.js）；本文件不镜像账号信息。
//   Q-11 local_lan 不纳入 —— 后端权威（范围决策）；本文件不镜像。
//   Q-12 真实短信不启动 / 回调默认关闭 —— 后端权威；前端不提供回执入口。
// ---------------------------------------------------------------------------

// 依赖待决 Q-06：来源渠道固定 7 项枚举，不用自由文本。
export const SOURCE_CHANNEL_OPTIONS = [
  { value: 'DOUYIN', label: '抖音' },
  { value: 'XIAOHONGSHU', label: '小红书' },
  { value: 'MEITUAN_DIANPING', label: '美团点评' },
  { value: 'WECHAT_PRIVATE', label: '微信私域' },
  { value: 'WALK_IN', label: '自然到店' },
  { value: 'REFERRAL', label: '转介绍' },
  { value: 'OTHER', label: '其他' },
];
export const SOURCE_CHANNEL_LABELS = Object.fromEntries(
  SOURCE_CHANNEL_OPTIONS.map(item => [item.value, item.label]),
);

// 依赖待决 Q-05：新老客标识（后端按历史成交判定，前端仅展示）。
export const CUSTOMER_TYPE_OPTIONS = [
  { value: 'NEW', label: '新客' },
  { value: 'RETURNING', label: '老客' },
];
export const CUSTOMER_TYPE_LABELS = Object.fromEntries(
  CUSTOMER_TYPE_OPTIONS.map(item => [item.value, item.label]),
);

// 依赖待决 Q-07：4 个床位 B1–B4；可约容量按「床位 × 时段」由后端计算。
export const BED_OPTIONS = ['B1', 'B2', 'B3', 'B4'].map(value => ({ value, label: `${value} 床位` }));

// 依赖待决 Q-09：八态筛选与展示。SIMULATED 明确标注「模拟成功（未送达）」，
// 绝不显示为「已送达」；ACCEPTED 为中间态，DELIVERED / REJECTED 为回执终态。
export const SMS_STATUS_OPTIONS = [
  { value: 'PENDING', label: '等待发送' },
  { value: 'SENDING', label: '发送中' },
  { value: 'ACCEPTED', label: '已受理' },
  { value: 'DELIVERED', label: '已送达' },
  { value: 'REJECTED', label: '运营商退回' },
  { value: 'SIMULATED', label: '模拟成功（未送达）' },
  { value: 'FAILED', label: '发送失败' },
  { value: 'SKIPPED', label: '已跳过' },
];
export const SMS_STATUS_LABELS = Object.fromEntries(
  SMS_STATUS_OPTIONS.map(item => [item.value, item.label]),
);
export const SMS_STATUS_TAG_TYPES = {
  PENDING: 'info',
  SENDING: 'primary',
  ACCEPTED: 'primary',
  DELIVERED: 'success',
  REJECTED: 'danger',
  SIMULATED: 'warning',
  FAILED: 'danger',
  SKIPPED: 'info',
};

// 依赖待决 Q-01 / Q-03：套餐持有状态（含新增 REFUNDED / VOID 两个取值，不改 enum）。
export const PACKAGE_STATUS_LABELS = {
  ACTIVE: '可使用',
  PAUSED: '已暂停',
  REFUNDED: '已退款',
  VOID: '已作废',
};

// 依赖待决 Q-05 / Q-06 / Q-07：旧预约记录三字段为 NULL 时统一显示「未标注」。
export const UNLABELLED_TEXT = '未标注';
