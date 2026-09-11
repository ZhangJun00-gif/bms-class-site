CREATE TABLE `PhotoOriginal` (
  `photoId` VARCHAR(191) NOT NULL,
  `objectKey` VARCHAR(500) NULL,
  `data` LONGBLOB NULL,
  `mimeType` VARCHAR(100) NOT NULL,
  `size` INTEGER NOT NULL,
  `width` INTEGER NOT NULL,
  `height` INTEGER NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `PhotoOriginal_objectKey_key`(`objectKey`),
  PRIMARY KEY (`photoId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MediaObjectOperation` (
  `id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(20) NOT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'UPLOADING',
  `actorId` VARCHAR(191) NULL,
  `albumId` VARCHAR(191) NULL,
  `photoId` VARCHAR(191) NULL,
  `idempotencyKey` VARCHAR(191) NULL,
  `requestHash` CHAR(64) NULL,
  `manifest` JSON NOT NULL,
  `leaseOwnerToken` VARCHAR(191) NULL,
  `leasedUntil` DATETIME(3) NULL,
  `nextAttemptAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `errorMessage` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `MediaObjectOperation_status_nextAttemptAt_leasedUntil_idx`(`status`, `nextAttemptAt`, `leasedUntil`),
  INDEX `MediaObjectOperation_photoId_idx`(`photoId`),
  UNIQUE INDEX `MediaObjectOperation_actorId_albumId_idempotencyKey_key`(`actorId`, `albumId`, `idempotencyKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PhotoOriginal` ADD CONSTRAINT `PhotoOriginal_photoId_fkey`
  FOREIGN KEY (`photoId`) REFERENCES `Photo`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
