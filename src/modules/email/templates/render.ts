import type { EmailTemplate, Locale } from '@darmawanweb/ais-its-contracts/domain';
import type { EmailRequestedV1 } from '@darmawanweb/ais-its-contracts/events';

import {
  layoutEmail,
  type RenderedEmail,
  TEMPLATE_DATA_SCHEMAS,
  type TemplateData,
  templateContent,
} from './templates.js';

/** Template data that does not satisfy the template's schema (never retried). */
export class EmailTemplateDataError extends Error {
  override readonly name = 'EmailTemplateDataError';

  constructor(
    readonly template: EmailTemplate,
    readonly issues: readonly string[],
  ) {
    super(`Invalid data for e-mail template ${template}: ${issues.join('; ')}`);
  }
}

/** Validates the data of a template. @throws {EmailTemplateDataError} */
export function parseTemplateData<Name extends EmailTemplate>(
  template: Name,
  data: unknown,
): TemplateData[Name] {
  const result = TEMPLATE_DATA_SCHEMAS[template].safeParse(data);
  if (!result.success) {
    throw new EmailTemplateDataError(
      template,
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(data)'}: ${issue.message}`,
      ),
    );
  }
  return result.data as TemplateData[Name];
}

/**
 * Renders a transactional e-mail (`notify.email.requested.v1`) in its locale:
 * the data is validated against the template's schema, links must be
 * absolute http(s) URLs, and every value is HTML-escaped in the HTML part.
 *
 * @throws {EmailTemplateDataError} when the data does not fit the template
 */
export function renderEmail(request: EmailRequestedV1): RenderedEmail {
  const data = parseTemplateData(request.template, request.data);
  return renderTemplate(request.template, request.locale, data);
}

/** Renders validated template data. */
export function renderTemplate<Name extends EmailTemplate>(
  template: Name,
  locale: Locale,
  data: TemplateData[Name],
): RenderedEmail {
  return layoutEmail(locale, templateContent(template, locale, data));
}
