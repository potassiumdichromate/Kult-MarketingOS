import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newRequestId } from '@kult/shared';
import type { AuthContext } from '@kult/auth';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    /** Populated by AuthGuard. Absent on public routes. */
    auth?: AuthContext;
  }
}

/**
 * Assigns a request id and echoes it back.
 *
 * The id threads through logs, agent executions, workflow executions, and audit
 * rows, so a single support question can be traced from an HTTP call all the way
 * to a provider response.
 *
 * An inbound x-request-id is accepted only if it looks like an opaque id, so a
 * caller cannot inject newlines or control characters into the log stream.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.header('x-request-id');
    request.requestId =
      inbound && /^[A-Za-z0-9_.:-]{8,128}$/.test(inbound) ? inbound : newRequestId();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
