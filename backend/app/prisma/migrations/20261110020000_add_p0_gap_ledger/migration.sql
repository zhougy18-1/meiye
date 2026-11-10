-- 20261110020000_add_p0_gap_ledger
-- P0 缺口补齐：单支 additive 迁移，全部 ADD COLUMN ... NULL / CREATE TABLE。
-- 无 DROP、无回填、无新增 NOT NULL 列，旧演示数据（3 会员 / 2 套餐 / demo-holding-001 /
-- 3 条 PackageUsage / 既有 SmsNotification 与 Appointment 行）零破坏。

-- 依赖待决 Q-01 / Q-03 / Q-04，当前采用建议默认值，待经营者确认后可调整：
-- 独立套餐退款/作废审计台账；不写旧 Transaction，不删除任何既有行，不冗余复制购买快照。
CREATE TABLE `PackageRefundAudit` (
  `id`                  VARCHAR(191) NOT NULL,
  `holdingId`           VARCHAR(191) NOT NULL,
  `action`              VARCHAR(16)  NOT NULL,
  `refundAmount`        DECIMAL(10,2) NOT NULL,
  `remainingUsesBefore` INTEGER NOT NULL,
  `remainingUsesAfter`  INTEGER NOT NULL,
  `prevStatus`          VARCHAR(16)  NOT NULL,
  `reason`              VARCHAR(500) NOT NULL,
  `approvedBy`          VARCHAR(191) NOT NULL,
  `operatorId`          VARCHAR(191) NOT NULL,
  `operatorName`        VARCHAR(191) NOT NULL,
  `occurredAt`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `requestKey`          VARCHAR(128) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `PackageRefundAudit_requestKey_key` (`requestKey`),
  INDEX `PackageRefundAudit_holdingId_occurredAt_idx` (`holdingId`, `occurredAt`),
  INDEX `PackageRefundAudit_occurredAt_idx` (`occurredAt`),
  INDEX `PackageRefundAudit_action_idx` (`action`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PackageRefundAudit`
  ADD CONSTRAINT `PackageRefundAudit_holdingId_fkey`
  FOREIGN KEY (`holdingId`) REFERENCES `PackageHolding` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 依赖待决 Q-09 / Q-12，当前采用建议默认值，待经营者确认后可调整：
-- SmsNotification 回执字段，全部 NULL；发送期失败字段（providerCode/errorMessage）语义不变。
ALTER TABLE `SmsNotification`
  ADD COLUMN `receiptAt`         DATETIME(3)  NULL,
  ADD COLUMN `terminalStatus`    VARCHAR(16)  NULL,
  ADD COLUMN `rejectCode`        VARCHAR(191) NULL,
  ADD COLUMN `rejectReason`      VARCHAR(500) NULL,
  ADD COLUMN `receiptRequestId`  VARCHAR(191) NULL;

-- 依赖待决 Q-05 / Q-06 / Q-07，当前采用建议默认值，待经营者确认后可调整：
-- Appointment 新字段，全部 NULL；旧预约显示「未标注」；索引支撑床位冲突查询。
ALTER TABLE `Appointment`
  ADD COLUMN `customerType`  VARCHAR(16) NULL,
  ADD COLUMN `sourceChannel` VARCHAR(32) NULL,
  ADD COLUMN `bedId`         VARCHAR(16) NULL,
  ADD INDEX `Appointment_appointmentTime_bedId_idx` (`appointmentTime`, `bedId`);
