import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports liveness without probing dependencies', () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const vectors = { readiness: jest.fn() };
    const controller = new HealthController(prisma as never, vectors as never);

    expect(controller.get()).toMatchObject({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports readiness only after database and vector checks pass', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const vectors = {
      readiness: jest.fn().mockResolvedValue({ collection: 'collection' }),
    };
    const controller = new HealthController(prisma as never, vectors as never);

    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ok',
      dependencies: { database: 'ok' },
    });
  });

  it('reports unavailable without exposing the dependency error', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('secret connection')),
    };
    const vectors = { readiness: jest.fn().mockResolvedValue({}) };
    const controller = new HealthController(prisma as never, vectors as never);

    await expect(controller.ready()).rejects.toEqual(
      new ServiceUnavailableException('dependency unavailable'),
    );
  });
});
