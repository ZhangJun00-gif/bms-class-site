CREATE TABLE `Announcement` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(160) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `status` ENUM('DRAFT', 'PUBLISHED', 'WITHDRAWN') NOT NULL DEFAULT 'DRAFT',
  `revision` INTEGER NOT NULL DEFAULT 1,
  `createdById` VARCHAR(191) NOT NULL,
  `publishedById` VARCHAR(191) NULL,
  `publishedAt` DATETIME(3) NULL,
  `withdrawnAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `Announcement_status_publishedAt_id_idx`(`status`, `publishedAt`, `id`),
  INDEX `Announcement_createdAt_id_idx`(`createdAt`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnnouncementRead` (
  `userId` VARCHAR(191) NOT NULL,
  `announcementId` VARCHAR(191) NOT NULL,
  `readAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AnnouncementRead_announcementId_idx`(`announcementId`),
  PRIMARY KEY (`userId`, `announcementId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Announcement` ADD CONSTRAINT `Announcement_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Announcement` ADD CONSTRAINT `Announcement_publishedById_fkey`
  FOREIGN KEY (`publishedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AnnouncementRead` ADD CONSTRAINT `AnnouncementRead_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AnnouncementRead` ADD CONSTRAINT `AnnouncementRead_announcementId_fkey`
  FOREIGN KEY (`announcementId`) REFERENCES `Announcement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
