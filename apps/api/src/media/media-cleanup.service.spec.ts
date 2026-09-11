import { Logger } from "@nestjs/common";
import { MediaCleanupService } from "./media-cleanup.service";

const recovery = {
  planDeletion: jest.fn().mockResolvedValue('cleanup-1'),
  recover: jest.fn().mockResolvedValue(true),
  protectedKeys: jest.fn().mockResolvedValue([]),
};

describe("MediaCleanupService", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    recovery.planDeletion.mockClear();
    recovery.recover.mockReset().mockResolvedValue(true);
    process.env = {
      ...originalEnv,
      MEDIA_ORPHAN_GRACE_MS: "3600000",
      MEDIA_ORPHAN_CLEANUP_BATCH_SIZE: "10",
      MEDIA_ORPHAN_CLEANUP_ENABLED: "true",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does nothing outside COS mode", async () => {
    const prisma = { photo: { findMany: jest.fn() } };
    const storage = { usesCos: jest.fn().mockReturnValue(false) };
    const service = new MediaCleanupService(prisma as never, storage as never, recovery as never);

    await expect(service.runCleanup()).resolves.toEqual(
      expect.objectContaining({ skipped: true }),
    );
    expect(prisma.photo.findMany).not.toHaveBeenCalled();
  });

  it("does not register or run cleanup when the deployment gate is disabled", async () => {
    process.env.MEDIA_ORPHAN_CLEANUP_ENABLED = "false";
    const logger = jest.spyOn(Logger.prototype, "log").mockImplementation();
    const prisma = { photo: { findMany: jest.fn() } };
    const storage = { usesCos: jest.fn().mockReturnValue(true) };
    const service = new MediaCleanupService(prisma as never, storage as never, recovery as never);

    service.onApplicationBootstrap();
    await expect(service.runCleanup()).resolves.toEqual(
      expect.objectContaining({ skipped: true }),
    );

    expect(prisma.photo.findMany).not.toHaveBeenCalled();
    expect(
      (service as unknown as { timer: NodeJS.Timeout | null }).timer,
    ).toBeNull();
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]?.[0]).toContain("media.orphan-cleanup-status");
    expect(logger.mock.calls[0]?.[0]).not.toContain("objectKey");
    logger.mockRestore();
  });

  it("removes only still-unreferenced tracked photos and old untracked objects", async () => {
    const photo = {
      findFirst: jest.fn()
        .mockResolvedValueOnce({ id: 'orphan-photo', objectKey: 'media/2026/07/tracked.webp', original: { objectKey: 'album-originals/2026/07/original.png' } })
        .mockResolvedValueOnce(null),
      findMany: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: "orphan-photo",
            objectKey: "media/2026/07/tracked.webp",
          },
          {
            id: "claimed-photo",
            objectKey: "media/2026/07/claimed.webp",
          },
        ])
        .mockResolvedValueOnce([
          { objectKey: "media/2026/07/referenced.webp" },
        ]),
      deleteMany: jest
        .fn()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 }),
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };
    const quizImportAsset = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    };
    const knowledgeImportAsset = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    };
    const transaction = { photo, $queryRaw: jest.fn(), photoOriginal: { deleteMany: jest.fn() } };
    const prisma = { photo, quizImportAsset, knowledgeImportAsset,
      $transaction: jest.fn(async (action) => action(transaction)),
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      delete: jest.fn().mockResolvedValue(undefined),
      listObjects: jest.fn().mockResolvedValue([
        {
          key: "media/2026/07/referenced.webp",
          size: 1,
          lastModified: "2026-07-20T00:00:00.000Z",
        },
        {
          key: "media/2026/07/untracked-old.webp",
          size: 1,
          lastModified: "2026-07-20T00:00:00.000Z",
        },
        {
          key: "media/2026/07/untracked-new.webp",
          size: 1,
          lastModified: "2026-07-22T11:30:00.000Z",
        },
      ]),
    };
    const service = new MediaCleanupService(prisma as never, storage as never, recovery as never);

    await expect(
      service.runCleanup(new Date("2026-07-22T12:00:00.000Z")),
    ).resolves.toEqual({
      skipped: false,
      trackedDeleted: 1,
      untrackedDeleted: 1,
      failed: 0,
    });
    expect(photo.deleteMany).toHaveBeenCalledTimes(1);
    expect(recovery.planDeletion).toHaveBeenCalledWith(transaction, 'orphan-photo', [
      'media/2026/07/tracked.webp', 'album-originals/2026/07/original.png',
    ]);
    expect(recovery.recover).toHaveBeenCalledWith('cleanup-1', true);
    expect(storage.delete).toHaveBeenCalledWith(
      "media/2026/07/untracked-old.webp",
    );
    expect(storage.delete).not.toHaveBeenCalledWith(
      "media/2026/07/untracked-new.webp",
    );
    expect(quizImportAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          objectKey: "media/2026/07/untracked-old.webp",
        }),
      }),
    );
  });

  it("continues after an object deletion failure and reports it", async () => {
    const logger = jest.spyOn(Logger.prototype, "error").mockImplementation();
    recovery.recover.mockRejectedValue(new Error('COS unavailable'));
    const prisma = {
      $queryRaw: jest.fn(),
      photoOriginal: { deleteMany: jest.fn() },
      $transaction: jest.fn(),
      photo: {
        findFirst: jest.fn().mockResolvedValue({ id: 'photo-1', objectKey: 'media/2026/07/photo.webp' }),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: "photo-1", objectKey: "media/2026/07/photo.webp" },
          ])
          .mockResolvedValueOnce([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizImportAsset: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      knowledgeImportAsset: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      delete: jest.fn().mockRejectedValue(new Error("COS unavailable")),
      listObjects: jest.fn().mockResolvedValue([
        {
          key: "media/2026/07/photo.webp",
          size: 1,
          lastModified: "2026-07-20T00:00:00.000Z",
        },
      ]),
    };
    prisma.$transaction.mockImplementation(async (action) => action(prisma));
    const service = new MediaCleanupService(prisma as never, storage as never, recovery as never);

    await expect(service.runCleanup()).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("media.orphan-object"),
      expect.anything(),
    );
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
    logger.mockRestore();
  });

  it("protects active import objects before listing and immediately before deletion", async () => {
    const prisma = {
      photo: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      quizImportAsset: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ objectKey: "media/2026/07/active.webp" }])
          .mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: "asset-1" }),
      },
      knowledgeImportAsset: {
        findMany: jest.fn().mockResolvedValue([
          { objectKey: "media/2026/07/knowledge-active.webp" },
        ]),
        findFirst: jest.fn().mockResolvedValue({ id: "knowledge-asset-1" }),
      },
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      delete: jest.fn().mockResolvedValue(undefined),
      listObjects: jest.fn().mockResolvedValue([
        {
          key: "media/2026/07/active.webp",
          size: 1,
          lastModified: "2026-07-20T00:00:00.000Z",
        },
        {
          key: "media/2026/07/knowledge-active.webp",
          size: 1,
          lastModified: "2026-07-20T00:00:00.000Z",
        },
      ]),
    };
    const service = new MediaCleanupService(prisma as never, storage as never, recovery as never);

    await expect(
      service.runCleanup(new Date("2026-07-22T12:00:00.000Z")),
    ).resolves.toEqual(expect.objectContaining({ untrackedDeleted: 0 }));
    expect(storage.delete).not.toHaveBeenCalled();

    await service.runCleanup(new Date("2026-07-22T12:00:00.000Z"));
    expect(prisma.quizImportAsset.findFirst).toHaveBeenCalled();
    expect(prisma.knowledgeImportAsset.findFirst).toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
