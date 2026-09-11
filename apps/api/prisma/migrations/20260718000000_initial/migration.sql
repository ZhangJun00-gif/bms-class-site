CREATE TABLE `User` (
  `id` VARCHAR(191) NOT NULL, `displayName` VARCHAR(80) NOT NULL,
  `studentNumberHash` CHAR(64) NOT NULL, `studentNumberEncrypted` TEXT NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL, `role` ENUM('MEMBER','EDITOR','ADMIN') NOT NULL DEFAULT 'MEMBER',
  `status` ENUM('PENDING','ACTIVE','SUSPENDED') NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, `approvedAt` DATETIME(3) NULL,
  UNIQUE INDEX `User_studentNumberHash_key`(`studentNumberHash`), INDEX `User_status_role_idx`(`status`,`role`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Session` (
  `id` VARCHAR(191) NOT NULL, `tokenHash` CHAR(64) NOT NULL, `csrfToken` VARCHAR(96) NOT NULL, `userId` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `Session_tokenHash_key`(`tokenHash`), INDEX `Session_userId_expiresAt_idx`(`userId`,`expiresAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Invite` (
  `id` VARCHAR(191) NOT NULL, `codeHash` CHAR(64) NOT NULL, `label` VARCHAR(120) NOT NULL, `active` BOOLEAN NOT NULL DEFAULT true,
  `maxUses` INTEGER NOT NULL DEFAULT 1, `usedCount` INTEGER NOT NULL DEFAULT 0, `expiresAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `Invite_codeHash_key`(`codeHash`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AuditLog` (
  `id` VARCHAR(191) NOT NULL, `actorId` VARCHAR(191) NULL, `action` VARCHAR(100) NOT NULL, `targetType` VARCHAR(80) NOT NULL,
  `targetId` VARCHAR(64) NULL, `metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AuditLog_createdAt_idx`(`createdAt`), INDEX `AuditLog_actorId_createdAt_idx`(`actorId`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `News` (
  `id` VARCHAR(191) NOT NULL, `title` VARCHAR(160) NOT NULL, `summary` VARCHAR(300) NOT NULL, `body` LONGTEXT NOT NULL,
  `status` ENUM('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT', `visibility` ENUM('PUBLIC','MEMBERS') NOT NULL DEFAULT 'MEMBERS',
  `authorId` VARCHAR(191) NOT NULL, `publishedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL, `deletedAt` DATETIME(3) NULL,
  INDEX `News_status_visibility_publishedAt_idx`(`status`,`visibility`,`publishedAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Album` (
  `id` VARCHAR(191) NOT NULL, `title` VARCHAR(160) NOT NULL, `description` TEXT NOT NULL, `authorId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, `deletedAt` DATETIME(3) NULL, PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Photo` (
  `id` VARCHAR(191) NOT NULL, `albumId` VARCHAR(191) NOT NULL, `objectKey` VARCHAR(500) NOT NULL, `caption` VARCHAR(300) NOT NULL DEFAULT '',
  `mimeType` VARCHAR(100) NOT NULL, `size` INTEGER NOT NULL, `width` INTEGER NULL, `height` INTEGER NULL, `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX `Photo_objectKey_key`(`objectKey`),
  INDEX `Photo_albumId_sortOrder_idx`(`albumId`,`sortOrder`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ForumThread` (
  `id` VARCHAR(191) NOT NULL, `title` VARCHAR(160) NOT NULL, `body` LONGTEXT NOT NULL, `authorId` VARCHAR(191) NOT NULL,
  `pinned` BOOLEAN NOT NULL DEFAULT false, `locked` BOOLEAN NOT NULL DEFAULT false, `hidden` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, `deletedAt` DATETIME(3) NULL,
  INDEX `ForumThread_pinned_updatedAt_idx`(`pinned`,`updatedAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ForumPost` (
  `id` VARCHAR(191) NOT NULL, `threadId` VARCHAR(191) NOT NULL, `body` LONGTEXT NOT NULL, `authorId` VARCHAR(191) NOT NULL,
  `hidden` BOOLEAN NOT NULL DEFAULT false, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL, INDEX `ForumPost_threadId_createdAt_idx`(`threadId`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ForumReport` (
  `id` VARCHAR(191) NOT NULL, `reason` VARCHAR(500) NOT NULL, `reporterId` VARCHAR(191) NOT NULL, `threadId` VARCHAR(191) NULL,
  `postId` VARCHAR(191) NULL, `resolvedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `ForumReport_resolvedAt_createdAt_idx`(`resolvedAt`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeDocument` (
  `id` VARCHAR(191) NOT NULL, `title` VARCHAR(200) NOT NULL, `kind` ENUM('ARTICLE','PDF','DOCX') NOT NULL, `body` LONGTEXT NULL,
  `objectKey` VARCHAR(500) NULL, `sourceName` VARCHAR(255) NULL, `status` ENUM('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `indexStatus` ENUM('PENDING','PROCESSING','READY','FAILED') NOT NULL DEFAULT 'PENDING', `authorId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, `publishedAt` DATETIME(3) NULL, `deletedAt` DATETIME(3) NULL,
  INDEX `KnowledgeDocument_status_indexStatus_idx`(`status`,`indexStatus`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeChunk` (
  `id` VARCHAR(191) NOT NULL, `documentId` VARCHAR(191) NOT NULL, `chunkIndex` INTEGER NOT NULL, `content` TEXT NOT NULL,
  `pageNumber` INTEGER NULL, `vectorRef` VARCHAR(255) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `KnowledgeChunk_documentId_chunkIndex_key`(`documentId`,`chunkIndex`), FULLTEXT INDEX `KnowledgeChunk_content_idx`(`content`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `IndexJob` (
  `id` VARCHAR(191) NOT NULL, `documentId` VARCHAR(191) NOT NULL, `status` ENUM('PENDING','PROCESSING','READY','FAILED') NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0, `error` TEXT NULL, `leasedUntil` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  INDEX `IndexJob_status_createdAt_idx`(`status`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizQuestion` (
  `id` VARCHAR(191) NOT NULL, `type` ENUM('SINGLE','MULTIPLE','TRUE_FALSE') NOT NULL, `subject` VARCHAR(100) NOT NULL,
  `chapter` VARCHAR(100) NOT NULL, `difficulty` INTEGER NOT NULL DEFAULT 1, `prompt` TEXT NOT NULL, `options` JSON NOT NULL,
  `correctAnswer` JSON NOT NULL, `explanation` TEXT NOT NULL, `enabled` BOOLEAN NOT NULL DEFAULT true, `authorId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  INDEX `QuizQuestion_enabled_subject_chapter_difficulty_idx`(`enabled`,`subject`,`chapter`,`difficulty`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizAttempt` (
  `id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `snapshot` JSON NOT NULL, `answers` JSON NULL, `results` JSON NULL,
  `score` INTEGER NULL, `total` INTEGER NOT NULL, `submittedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `QuizAttempt_userId_createdAt_idx`(`userId`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiConversation` (
  `id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `title` VARCHAR(160) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  INDEX `AiConversation_userId_updatedAt_idx`(`userId`,`updatedAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiMessage` (
  `id` VARCHAR(191) NOT NULL, `conversationId` VARCHAR(191) NOT NULL, `role` VARCHAR(20) NOT NULL, `content` LONGTEXT NOT NULL,
  `citations` JSON NULL, `model` VARCHAR(120) NULL, `tokenCount` INTEGER NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AiMessage_conversationId_createdAt_idx`(`conversationId`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `News` ADD CONSTRAINT `News_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Album` ADD CONSTRAINT `Album_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Photo` ADD CONSTRAINT `Photo_albumId_fkey` FOREIGN KEY (`albumId`) REFERENCES `Album`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ForumThread` ADD CONSTRAINT `ForumThread_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ForumPost` ADD CONSTRAINT `ForumPost_threadId_fkey` FOREIGN KEY (`threadId`) REFERENCES `ForumThread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ForumPost` ADD CONSTRAINT `ForumPost_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ForumReport` ADD CONSTRAINT `ForumReport_reporterId_fkey` FOREIGN KEY (`reporterId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ForumReport` ADD CONSTRAINT `ForumReport_threadId_fkey` FOREIGN KEY (`threadId`) REFERENCES `ForumThread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ForumReport` ADD CONSTRAINT `ForumReport_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `ForumPost`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `KnowledgeDocument` ADD CONSTRAINT `KnowledgeDocument_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `IndexJob` ADD CONSTRAINT `IndexJob_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `QuizQuestion` ADD CONSTRAINT `QuizQuestion_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `QuizAttempt` ADD CONSTRAINT `QuizAttempt_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiConversation` ADD CONSTRAINT `AiConversation_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiMessage` ADD CONSTRAINT `AiMessage_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `AiConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

