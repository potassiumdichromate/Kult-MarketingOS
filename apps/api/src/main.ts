// Loads .env for local development, checking the app directory first and then the
// monorepo root. In containers there is no .env file, so this is a no-op and real
// environment variables always take precedence.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')], quiet: true });
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ConfigurationError, getConfig } from '@kult/config';
import { AppModule } from './app.module.js';
import { ErrorsFilter } from './common/errors.filter.js';
import { APP_CONFIG } from './common/tokens.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  let config;
  try {
    config = getConfig();
  } catch (error) {
    // A misconfigured deployment must fail loudly at startup, listing exactly
    // what is wrong, rather than starting and failing on the first request.
    if (error instanceof ConfigurationError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    logger: config.isProduction ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
  });

  // nginx terminates TLS and forwards X-Forwarded-*. Without this, req.ip is the
  // proxy address and audit logs record the wrong client.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON only; a restrictive CSP costs nothing here.
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(cookieParser());

  // Explicit allowlist. A request from an unlisted origin is rejected outright
  // rather than being reflected back.
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true); // same-origin / server-to-server
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS policy.`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Organization-Id', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'ready'],
  });

  // Request validation is done per route with ZodValidationPipe, which parses
  // and strips unknown keys. Nest's global ValidationPipe is deliberately not
  // installed: it depends on class-validator, which this codebase does not use.
  app.useGlobalFilters(new ErrorsFilter(app.get(APP_CONFIG)));
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('Kult Marketing OS API')
    .setDescription(
      'Internal marketing intelligence and automation API for Kult. ' +
        'All authenticated routes require a Privy access token as a bearer credential.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Privy access token' },
      'privy',
    )
    .addGlobalParameters({
      name: 'X-Organization-Id',
      in: 'header',
      required: false,
      description: "Selects which of the caller's organizations the request applies to.",
      schema: { type: 'string' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, swagger);
  // The schema is useful in every environment; the interactive explorer is not
  // something to expose publicly in production.
  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    jsonDocumentUrl: 'api/v1/openapi.json',
  });

  await app.listen(config.port, '0.0.0.0');

  logger.log(
    `Kult Marketing OS API listening on port ${config.port} (${config.appEnv}). ` +
      `Web origin: ${config.webUrl}.`,
  );
}

void bootstrap();
