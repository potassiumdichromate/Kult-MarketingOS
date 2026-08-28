import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AppConfig } from '@kult/config';
import { checkDatabase, type PrismaClient } from '@kult/database';
import { Public } from '../auth/auth.guard.js';
import { RedisService } from '../common/core.module.js';
import { APP_CONFIG, PRISMA } from '../common/tokens.js';

/**
 * Health and readiness.
 *
 * /health is a liveness probe: the process is up and serving. It never touches a
 * dependency, so a database blip does not cause the orchestrator to kill an
 * otherwise healthy container.
 *
 * /ready is a readiness probe: the process can actually serve traffic, which
 * means Postgres and Redis both answer. A failing dependency is named, but the
 * response never includes a host, port, or connection string.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  health(): { status: 'ok'; environment: string; version: string } {
    return {
      status: 'ok',
      environment: this.config.appEnv,
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }

  @Public()
  @Get('ready')
  @ApiExcludeEndpoint()
  async ready(@Res() response: Response): Promise<void> {
    const [database, redis] = await Promise.all([
      checkDatabase(this.prisma),
      this.redis.ping(),
    ]);

    const ready = database && redis;
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: database ? 'ok' : 'unavailable',
        redis: redis ? 'ok' : 'unavailable',
      },
    });
  }
}
