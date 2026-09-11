ALTER TABLE `News`
  ADD COLUMN `bodyFormat` VARCHAR(20) NOT NULL DEFAULT 'HTML_V1';

ALTER TABLE `Photo`
  DROP FOREIGN KEY `Photo_albumId_fkey`,
  MODIFY `albumId` VARCHAR(191) NULL,
  MODIFY `objectKey` VARCHAR(500) NULL,
  ADD COLUMN `uploadedById` VARCHAR(191) NULL,
  ADD COLUMN `data` LONGBLOB NULL;

UPDATE `Photo`
JOIN `Album` ON `Album`.`id` = `Photo`.`albumId`
SET `Photo`.`uploadedById` = `Album`.`authorId`
WHERE `Photo`.`uploadedById` IS NULL;

CREATE INDEX `Photo_uploadedById_createdAt_idx` ON `Photo`(`uploadedById`, `createdAt`);

CREATE TABLE `NewsPhoto` (
  `newsId` VARCHAR(191) NOT NULL,
  `photoId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `NewsPhoto_photoId_idx`(`photoId`),
  PRIMARY KEY (`newsId`, `photoId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Photo`
  ADD CONSTRAINT `Photo_albumId_fkey`
    FOREIGN KEY (`albumId`) REFERENCES `Album`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Photo_uploadedById_fkey`
    FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `NewsPhoto`
  ADD CONSTRAINT `NewsPhoto_newsId_fkey`
    FOREIGN KEY (`newsId`) REFERENCES `News`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `NewsPhoto_photoId_fkey`
    FOREIGN KEY (`photoId`) REFERENCES `Photo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
