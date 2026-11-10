ALTER TABLE `Member`
  ADD COLUMN `smsNotificationEnabled` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `SmsNotification` (
  `id` VARCHAR(191) NOT NULL,
  `transactionId` VARCHAR(191) NOT NULL,
  `memberId` VARCHAR(191) NULL,
  `phoneLast4` VARCHAR(4) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `provider` VARCHAR(32) NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL,
  `balanceAfter` DECIMAL(10,2) NOT NULL,
  `occurredAt` DATETIME(3) NOT NULL,
  `messagePreview` VARCHAR(500) NOT NULL,
  `templateParams` JSON NOT NULL,
  `providerRequestId` VARCHAR(191) NULL,
  `providerCode` VARCHAR(191) NULL,
  `errorMessage` VARCHAR(500) NULL,
  `attemptCount` INTEGER NOT NULL DEFAULT 0,
  `lastAttemptAt` DATETIME(3) NULL,
  `nextAttemptAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `SmsNotification_transactionId_key` (`transactionId`),
  INDEX `SmsNotification_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
  INDEX `SmsNotification_memberId_createdAt_idx` (`memberId`, `createdAt`),
  INDEX `SmsNotification_createdAt_idx` (`createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SmsNotification`
  ADD CONSTRAINT `SmsNotification_transactionId_fkey`
  FOREIGN KEY (`transactionId`) REFERENCES `Transaction` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `SmsNotification`
  ADD CONSTRAINT `SmsNotification_memberId_fkey`
  FOREIGN KEY (`memberId`) REFERENCES `Member` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
