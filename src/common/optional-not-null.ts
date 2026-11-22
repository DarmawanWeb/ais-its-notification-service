import { ValidateIf } from 'class-validator';

/**
 * An optional body property that may be omitted but never `null`: the
 * property's validators are skipped only when it is absent (`undefined`), so
 * `null` fails them with `400 VALIDATION_FAILED` (spec §5) instead of
 * reaching the service as a value. Use it instead of `@IsOptional()`, which
 * also lets `null` through, on JSON bodies where `null` has no meaning.
 */
export function OptionalNotNull(): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined);
}
