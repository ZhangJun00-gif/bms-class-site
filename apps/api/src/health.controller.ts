import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './common/auth';
import { PrismaService } from './database/prisma.service';
import { KnowledgeVectorService } from './knowledge/knowledge-vector.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectors: KnowledgeVectorService,
  ) {}

  @Public()
  @Get()
  get() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      const [, vector] = await Promise.all([
        this.prisma.$queryRaw`SELECT 1`,
        this.vectors.readiness(),
      ]);
      return {
        status: 'ok',
        time: new Date().toISOString(),
        dependencies: { database: 'ok', vector },
      };
    } catch {
      throw new ServiceUnavailableException('dependency unavailable');
    }
  }
}
