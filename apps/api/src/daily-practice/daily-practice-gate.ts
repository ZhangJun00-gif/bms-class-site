import { Prisma } from '@prisma/client';

export async function lockDailyPracticeSettings(
  transaction: Prisma.TransactionClient,
) {
  const rows = await transaction.$queryRaw<Array<{ singletonId: number }>>(
    Prisma.sql`
      SELECT singletonId
      FROM DailyPracticeSettings
      WHERE singletonId = 1
      FOR UPDATE
    `,
  );
  if (rows.length !== 1) {
    throw new Error('DailyPracticeSettings singleton is missing');
  }
}
