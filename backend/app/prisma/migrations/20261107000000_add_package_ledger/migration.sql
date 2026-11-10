-- 次卡独立台账：不修改已有收银、储值卡及历史流水。
CREATE TABLE `PackagePlan` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `serviceId` VARCHAR(191) NOT NULL,
  `totalUses` INTEGER NOT NULL,
  `price` DECIMAL(10,2) NOT NULL,
  `validDays` INTEGER NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdBy` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`id`), INDEX `PackagePlan_serviceId_active_idx` (`serviceId`, `active`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PackageHolding` (
  `id` VARCHAR(191) NOT NULL,
  `memberId` VARCHAR(191) NOT NULL,
  `planId` VARCHAR(191) NOT NULL,
  `planName` VARCHAR(191) NOT NULL,
  `totalUses` INTEGER NOT NULL,
  `remainingUses` INTEGER NOT NULL,
  `paidAmount` DECIMAL(10,2) NOT NULL,
  `paymentMethod` ENUM('CASH','WECHAT_PAY','ALIPAY','DOUYIN','MEITUAN','CARD_SWIPE','MEMBER_CARD','OTHER') NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  `purchasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdByName` VARCHAR(191) NOT NULL,
  `requestKey` VARCHAR(128) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `PackageHolding_requestKey_key` (`requestKey`),
  INDEX `PackageHolding_memberId_purchasedAt_idx` (`memberId`, `purchasedAt`),
  INDEX `PackageHolding_planId_idx` (`planId`), INDEX `PackageHolding_status_expiresAt_idx` (`status`, `expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PackageUsage` (
  `id` VARCHAR(191) NOT NULL,
  `holdingId` VARCHAR(191) NOT NULL,
  `requestKey` VARCHAR(128) NOT NULL,
  `usedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `usedBy` VARCHAR(191) NOT NULL,
  `usedByName` VARCHAR(191) NOT NULL,
  `note` VARCHAR(500) NULL,
  `reversedAt` DATETIME(3) NULL,
  `reversedBy` VARCHAR(191) NULL,
  `reversedByName` VARCHAR(191) NULL,
  `reverseReason` VARCHAR(500) NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `PackageUsage_requestKey_key` (`requestKey`),
  INDEX `PackageUsage_holdingId_usedAt_idx` (`holdingId`, `usedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PackagePlan` ADD CONSTRAINT `PackagePlan_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `Service` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PackageHolding` ADD CONSTRAINT `PackageHolding_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `Member` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PackageHolding` ADD CONSTRAINT `PackageHolding_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `PackagePlan` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PackageUsage` ADD CONSTRAINT `PackageUsage_holdingId_fkey` FOREIGN KEY (`holdingId`) REFERENCES `PackageHolding` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
