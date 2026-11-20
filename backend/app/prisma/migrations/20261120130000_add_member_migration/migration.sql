ALTER TABLE `Member`
  MODIFY COLUMN `phone` VARCHAR(191) NULL,
  ADD COLUMN `externalId` VARCHAR(64) NULL,
  ADD COLUMN `classification` VARCHAR(100) NULL,
  MODIFY COLUMN `registrationDate` DATETIME(3) NULL,
  ADD COLUMN `historicalRecharge` DECIMAL(12,2) NULL,
  ADD COLUMN `historicalConsumption` DECIMAL(12,2) NULL,
  ADD COLUMN `openingBalanceNotes` TEXT NULL,
  ADD COLUMN `importBatchId` VARCHAR(191) NULL;

ALTER TABLE `Card`
  ADD COLUMN `openingBalance` DECIMAL(10,2) NULL,
  ADD COLUMN `importBatchId` VARCHAR(191) NULL;

ALTER TABLE `PackageHolding`
  ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'SALE',
  ADD COLUMN `importBatchId` VARCHAR(191) NULL,
  ADD COLUMN `openingRemainingUses` INTEGER NULL,
  ADD COLUMN `openingPurchasedUses` INTEGER NULL,
  ADD COLUMN `openingUsedUses` INTEGER NULL,
  ADD COLUMN `openingNotes` TEXT NULL;

CREATE TABLE `MemberMigrationBatch` (
  `id` VARCHAR(191) NOT NULL,
  `fileName` VARCHAR(255) NOT NULL,
  `fileHash` VARCHAR(64) NOT NULL,
  `cutoffAt` DATETIME(3) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'PREVIEW',
  `snapshot` JSON NOT NULL,
  `mappings` JSON NOT NULL,
  `issues` JSON NOT NULL,
  `previewSummary` JSON NOT NULL,
  `resultSummary` JSON NULL,
  `acknowledgements` JSON NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdByName` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `committedAt` DATETIME(3) NULL,
  `rolledBackAt` DATETIME(3) NULL,
  `rolledBackBy` VARCHAR(191) NULL,
  `rolledBackByName` VARCHAR(191) NULL,
  `rollbackReason` VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  INDEX `MemberMigrationBatch_fileHash_status_idx` (`fileHash`, `status`),
  INDEX `MemberMigrationBatch_status_createdAt_idx` (`status`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `Member_externalId_key` ON `Member`(`externalId`);
CREATE INDEX `Member_classification_idx` ON `Member`(`classification`);
CREATE INDEX `Member_importBatchId_idx` ON `Member`(`importBatchId`);
CREATE INDEX `Card_importBatchId_idx` ON `Card`(`importBatchId`);
CREATE INDEX `PackageHolding_source_idx` ON `PackageHolding`(`source`);
CREATE INDEX `PackageHolding_importBatchId_idx` ON `PackageHolding`(`importBatchId`);

ALTER TABLE `Member` ADD CONSTRAINT `Member_importBatchId_fkey` FOREIGN KEY (`importBatchId`) REFERENCES `MemberMigrationBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Card` ADD CONSTRAINT `Card_importBatchId_fkey` FOREIGN KEY (`importBatchId`) REFERENCES `MemberMigrationBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PackageHolding` ADD CONSTRAINT `PackageHolding_importBatchId_fkey` FOREIGN KEY (`importBatchId`) REFERENCES `MemberMigrationBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
