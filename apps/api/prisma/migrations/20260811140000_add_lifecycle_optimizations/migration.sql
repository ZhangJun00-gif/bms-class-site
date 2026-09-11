-- Additive lifecycle and keyset-pagination fields. Existing rows remain active
-- because archivedAt/revokedAt are nullable and are not backfilled.
ALTER TABLE `Album`
  ADD COLUMN `archivedAt` DATETIME(3) NULL;

ALTER TABLE `Invite`
  ADD COLUMN `revokedAt` DATETIME(3) NULL;

CREATE INDEX `Session_expires_id_idx`
  ON `Session`(`expiresAt`, `id`);

CREATE INDEX `Invite_active_expires_created_idx`
  ON `Invite`(`active`, `expiresAt`, `createdAt`);

CREATE INDEX `AuditLog_created_id_idx`
  ON `AuditLog`(`createdAt`, `id`);

CREATE INDEX `AuditLog_actor_created_id_idx`
  ON `AuditLog`(`actorId`, `createdAt`, `id`);

CREATE INDEX `AuditLog_action_created_id_idx`
  ON `AuditLog`(`action`, `createdAt`, `id`);

CREATE INDEX `AuditLog_target_created_id_idx`
  ON `AuditLog`(`targetType`, `targetId`, `createdAt`, `id`);

CREATE INDEX `Album_archived_created_id_idx`
  ON `Album`(`archivedAt`, `createdAt`, `id`);

CREATE INDEX `Photo_album_sort_created_id_idx`
  ON `Photo`(`albumId`, `sortOrder`, `createdAt`, `id`);

CREATE INDEX `QuizAttempt_lifecycle_expiry_id_idx`
  ON `QuizAttempt`(`lifecycleStatus`, `expiresAt`, `id`);

CREATE INDEX `QuizAttempt_lifecycle_abandoned_id_idx`
  ON `QuizAttempt`(`lifecycleStatus`, `abandonedAt`, `id`);

CREATE INDEX `AiConversation_user_updated_id_idx`
  ON `AiConversation`(`userId`, `updatedAt`, `id`);

CREATE INDEX `AiMessage_conversation_created_id_idx`
  ON `AiMessage`(`conversationId`, `createdAt`, `id`);
