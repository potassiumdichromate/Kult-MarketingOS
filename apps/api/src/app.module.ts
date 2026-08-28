import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { getConfig } from '@kult/config';
import { AuthGuard, PermissionsGuard } from './auth/auth.guard.js';
import { AuditService } from './common/audit.service.js';
import { CoreModule } from './common/core.module.js';
import { QueuesService } from './common/queues.service.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { HealthController } from './modules/health.controller.js';
import { OrganizationController } from './modules/organization/organization.controller.js';
import { OrganizationService } from './modules/organization/organization.service.js';
import { ContentController } from './modules/content/content.controller.js';
import { ContentService } from './modules/content/content.service.js';
import { IntegrationsController } from './modules/integrations/integrations.controller.js';
import { IntegrationsService } from './modules/integrations/integrations.service.js';
import { ResearchController } from './modules/research/research.controller.js';
import { ResearchService } from './modules/research/research.service.js';
import { CampaignsController } from './modules/campaigns/campaigns.controller.js';
import { CampaignsService } from './modules/campaigns/campaigns.service.js';
import { KnowledgeController } from './modules/knowledge/knowledge.controller.js';
import { KnowledgeService } from './modules/knowledge/knowledge.service.js';
import { InsightsController } from './modules/insights/insights.controller.js';
import { InsightsService } from './modules/insights/insights.service.js';
import { CopilotController, CopilotService } from './modules/copilot/copilot.controller.js';
import { CopilotToolsFactory } from './modules/copilot/copilot.tools.js';

/**
 * Root module.
 *
 * Guards are registered globally and run in order: rate limiting, then
 * authentication, then permissions. Registering them here rather than per
 * controller means a new route is protected by default - a route is only public
 * if it explicitly says so with @Public().
 */
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRootAsync({
      useFactory: () => {
        const config = getConfig();
        return {
          throttlers: [
            {
              ttl: config.rateLimit.ttlSeconds * 1000,
              limit: config.rateLimit.limit,
            },
          ],
        };
      },
    }),
  ],
  controllers: [
    HealthController,
    OrganizationController,
    ContentController,
    IntegrationsController,
    ResearchController,
    CampaignsController,
    KnowledgeController,
    InsightsController,
    CopilotController,
  ],
  providers: [
    AuditService,
    QueuesService,
    OrganizationService,
    ContentService,
    IntegrationsService,
    ResearchService,
    CampaignsService,
    KnowledgeService,
    InsightsService,
    CopilotService,
    CopilotToolsFactory,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*splat');
  }
}
