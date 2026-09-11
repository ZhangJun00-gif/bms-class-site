import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { MediaStorageService } from '../src/media/media-storage.service';
import { MediaObjectRecoveryService } from '../src/media/media-object-recovery.service';

dotenv.config({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const prisma = new PrismaClient();
const mediaStorage = new MediaStorageService();

async function run() {
  const originals = await new MediaObjectRecoveryService(prisma as never, mediaStorage).originalReport();
  const protectedOperationKeys = new Set(originals.pendingObjects.map((entry) => entry.key));
  const orphanWhere = {
    albumId: null,
    news: { none: {} },
    quizQuestions: { none: {} },
    knowledgeImages: { none: {} },
    knowledgeImportAssets: { none: {} },
  } as const;
  const [
    total,
    databaseBlobs,
    objectKeys,
    bothStorageColumns,
    albumLinked,
    newsLinked,
    quizLinked,
    orphaned,
    blobBytes,
    orphanItems,
    storedPhotos,
    knowledgeObjectKeys,
  ] = await Promise.all([
    prisma.photo.count(),
    prisma.photo.count({ where: { data: { not: null } } }),
    prisma.photo.count({ where: { objectKey: { not: null } } }),
    prisma.photo.count({
      where: { data: { not: null }, objectKey: { not: null } },
    }),
    prisma.photo.count({ where: { albumId: { not: null } } }),
    prisma.photo.count({ where: { news: { some: {} } } }),
    prisma.photo.count({ where: { quizQuestions: { some: {} } } }),
    prisma.photo.count({ where: orphanWhere }),
    prisma.photo.aggregate({
      where: { data: { not: null } },
      _sum: { size: true },
    }),
    prisma.photo.findMany({
      where: orphanWhere,
      select: {
        id: true,
        objectKey: true,
        size: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.photo.findMany({
      where: { objectKey: { not: null } },
      select: { id: true, objectKey: true },
    }),
    prisma.knowledgeDocument.count({
      where: { objectKey: { not: null } },
    }),
  ]);
  let cosComparison = null;
  if (mediaStorage.usesCos()) {
    const objects = await mediaStorage.listObjects();
    const databaseKeys = new Set(
      storedPhotos.map((photo) => photo.objectKey).filter(Boolean),
    );
    const cosKeys = new Set(objects.map((object) => object.key));
    cosComparison = {
      objectCount: objects.length,
      untrackedObjects: objects.filter(
        (object) => !databaseKeys.has(object.key) && !protectedOperationKeys.has(object.key),
      ),
      missingObjects: storedPhotos.filter(
        (photo) => photo.objectKey && !cosKeys.has(photo.objectKey),
      ),
    };
  }

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        originals,
        photos: {
          total,
          databaseBlobs,
          objectKeys,
          bothStorageColumns,
          albumLinked,
          newsLinked,
          quizLinked,
          orphaned,
          blobBytes: blobBytes._sum.size ?? 0,
          orphanItems,
          cosComparison,
        },
        knowledgeDocuments: {
          withObjectKey: knowledgeObjectKeys,
        },
      },
      null,
      2,
    ),
  );
}

void run()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : '媒体存储统计失败',
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
