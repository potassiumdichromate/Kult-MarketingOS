import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from '@kult/shared';

/**
 * Validates and coerces a request payload against a Zod schema.
 *
 * Returns the *parsed* value, so downstream code sees defaults applied, numbers
 * coerced from query strings, and unknown keys stripped. Anything not in the
 * schema never reaches a service, which is what stops a caller from smuggling
 * an organizationId or a status field into an update.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(
          'The request payload failed validation.',
          error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

/** Terser call site: `@Body(zodBody(schema))`. */
export const zodBody = <T extends ZodType>(schema: T) => new ZodValidationPipe(schema);
export const zodQuery = <T extends ZodType>(schema: T) => new ZodValidationPipe(schema);
