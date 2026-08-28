import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import type { AppConfig } from '@kult/config';
import { SOCIAL_PROVIDERS, ValidationError } from '@kult/shared';
import { Auth, Public, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService, clientIp } from '../../common/audit.service.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { IntegrationsService } from './integrations.service.js';

const providerParamSchema = z.enum(SOCIAL_PROVIDERS);

const connectSchema = z.object({
  redirectPath: z.string().max(500).optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const connectionIdSchema = z.object({ connectionId: z.string().min(1) });

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiBearerAuth('privy')
  @RequirePermissions('integrations:read')
  @ApiOperation({
    summary: 'List providers, their configuration status, and current connections',
    description:
      'Includes providers this deployment has no credentials for, along with the exact environment ' +
      'variables required to enable them. Tokens are never returned.',
  })
  async list(@Auth() auth: AuthContext) {
    return this.integrations.list(auth);
  }

  @Post(':provider/connect')
  @ApiBearerAuth('privy')
  @RequirePermissions('integrations:connect')
  @ApiOperation({
    summary: 'Begin an OAuth authorization',
    description:
      'Returns the provider authorization URL. The browser should navigate to it. State and, where ' +
      'applicable, the PKCE verifier are stored server-side and expire in ten minutes.',
  })
  async connect(
    @Auth() auth: AuthContext,
    @Param('provider') providerParam: string,
    @Body(zodBody(connectSchema)) body: z.infer<typeof connectSchema>,
  ) {
    const provider = providerParamSchema.parse(providerParam.toUpperCase());
    return this.integrations.beginAuthorization(auth, provider, body.redirectPath);
  }

  /**
   * OAuth redirect target.
   *
   * Public because the provider redirects the browser here with no Authorization
   * header. Authenticity comes from the single-use `state` value, which is bound
   * server-side to the organization and user that began the flow.
   */
  @Public()
  @Get(':provider/callback')
  @ApiOperation({ summary: 'OAuth callback (browser redirect target)' })
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Param('provider') providerParam: string,
    @Query(zodQuery(callbackQuerySchema)) query: z.infer<typeof callbackQuerySchema>,
  ): Promise<void> {
    const provider = providerParamSchema.parse(providerParam.toUpperCase());

    // The member declined, or the provider reported a failure.
    if (query.error) {
      return this.redirect(response, '/app/integrations', {
        status: 'error',
        provider,
        // Provider-supplied text is not reflected into the page; a fixed code is.
        reason: query.error === 'access_denied' ? 'declined' : 'provider_error',
      });
    }

    if (!query.code || !query.state) {
      return this.redirect(response, '/app/integrations', {
        status: 'error',
        provider,
        reason: 'missing_parameters',
      });
    }

    try {
      const result = await this.integrations.completeAuthorization({
        provider,
        code: query.code,
        state: query.state,
      });

      await this.audit.record({
        action: 'integrations.connected',
        organizationId: result.organizationId,
        resourceType: 'SocialConnection',
        resourceId: result.connectionId,
        ip: clientIp(request),
        userAgent: request.header('user-agent') ?? null,
        metadata: { provider },
      });

      return this.redirect(response, result.redirectPath ?? '/app/integrations', {
        status: 'connected',
        provider,
      });
    } catch (error) {
      // The browser gets a generic outcome; the detail goes to the logs and,
      // for genuine misconfiguration, to the integrations screen on next load.
      return this.redirect(response, '/app/integrations', {
        status: 'error',
        provider,
        reason: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'exchange_failed',
      });
    }
  }

  @Post(':provider/validate')
  @ApiBearerAuth('privy')
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'Re-check a connection and refresh its capability report' })
  async validate(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('provider') providerParam: string,
    @Body(zodBody(connectionIdSchema)) body: z.infer<typeof connectionIdSchema>,
  ) {
    providerParamSchema.parse(providerParam.toUpperCase());
    const result = await this.integrations.validate(auth, body.connectionId);
    await this.audit.fromRequest(request, auth, {
      action: 'integrations.validated',
      resourceType: 'SocialConnection',
      resourceId: body.connectionId,
      metadata: { valid: result.valid, status: result.status },
    });
    return result;
  }

  @Post(':provider/disconnect')
  @ApiBearerAuth('privy')
  @RequirePermissions('integrations:disconnect')
  @ApiOperation({ summary: 'Disconnect an account and delete its stored tokens' })
  async disconnect(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('provider') providerParam: string,
    @Body(zodBody(connectionIdSchema)) body: z.infer<typeof connectionIdSchema>,
  ) {
    const provider = providerParamSchema.parse(providerParam.toUpperCase());
    await this.integrations.disconnect(auth, body.connectionId);
    await this.audit.fromRequest(request, auth, {
      action: 'integrations.disconnected',
      resourceType: 'SocialConnection',
      resourceId: body.connectionId,
      metadata: { provider },
    });
    return { disconnected: true };
  }

  /** Builds a same-site redirect back into the web app. */
  private redirect(
    response: Response,
    path: string,
    params: Record<string, string>,
  ): void {
    if (!path.startsWith('/')) {
      throw new ValidationError('Invalid redirect path.', [
        { path: 'redirectPath', message: 'Must be an absolute same-site path.' },
      ]);
    }
    const url = new URL(path, this.config.webUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    response.redirect(302, url.toString());
  }
}
