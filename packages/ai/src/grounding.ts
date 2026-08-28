import type { PrismaClient } from '@kult/database';
import type { KnowledgeBase, RetrievedChunk } from './knowledge.js';

/**
 * Brand grounding.
 *
 * Every generation is preceded by retrieval of the organization's own brand
 * knowledge. The system instruction then states, in the strongest terms, that
 * factual assertions about the brand may come only from this block. This is what
 * stops the model inventing partnerships, user numbers, or token economics.
 */

export interface BrandContext {
  organizationName: string;
  timezone: string;
  profile: {
    description: string;
    positioning: string | null;
    mission: string | null;
    voiceSummary: string | null;
    toneAttributes: string[];
    writingRules: string[];
    bannedPhrases: string[];
  } | null;
  products: Array<{ name: string; description: string; url: string | null }>;
  audiences: Array<{ name: string; description: string; painPoints: string[] }>;
  competitors: Array<{ name: string; websiteUrl: string | null }>;
  approvedClaims: Array<{ id: string; claim: string; expiresAt: Date | null }>;
  forbiddenClaims: Array<{ claim: string; reason: string }>;
  guidelines: Array<{ category: string; rule: string; severity: string }>;
  /** Semantically retrieved knowledge relevant to the current task. */
  retrieved: RetrievedChunk[];
}

export class BrandContextLoader {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly knowledge: KnowledgeBase,
  ) {}

  /**
   * Loads the organization's brand context.
   *
   * `query` drives semantic retrieval; omit it for tasks that need only the
   * structured profile (for example a brand-rules check).
   */
  async load(organizationId: string, query?: string): Promise<BrandContext> {
    const [organization, profile, products, audiences, competitors, approved, forbidden, guidelines] =
      await Promise.all([
        this.prisma.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: { name: true, timezone: true },
        }),
        this.prisma.brandProfile.findUnique({ where: { organizationId } }),
        this.prisma.product.findMany({
          where: { organizationId, isActive: true },
          select: { name: true, description: true, url: true },
          take: 50,
        }),
        this.prisma.audience.findMany({
          where: { organizationId },
          select: { name: true, description: true, painPoints: true },
          take: 25,
        }),
        this.prisma.competitor.findMany({
          where: { organizationId },
          select: { name: true, websiteUrl: true },
          take: 25,
        }),
        this.prisma.approvedClaim.findMany({
          where: {
            organizationId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { id: true, claim: true, expiresAt: true },
          take: 200,
        }),
        this.prisma.forbiddenClaim.findMany({
          where: { organizationId },
          select: { claim: true, reason: true },
          take: 200,
        }),
        this.prisma.brandGuideline.findMany({
          where: { organizationId },
          select: { category: true, rule: true, severity: true },
          take: 100,
        }),
      ]);

    const retrieved = query ? await this.knowledge.retrieve(organizationId, query) : [];

    return {
      organizationName: organization.name,
      timezone: organization.timezone,
      profile: profile
        ? {
            description: profile.description,
            positioning: profile.positioning,
            mission: profile.mission,
            voiceSummary: profile.voiceSummary,
            toneAttributes: profile.toneAttributes,
            writingRules: profile.writingRules,
            bannedPhrases: profile.bannedPhrases,
          }
        : null,
      products,
      audiences,
      competitors,
      approvedClaims: approved,
      forbiddenClaims: forbidden,
      guidelines,
      retrieved,
    };
  }
}

/** Renders the brand context as the grounding block of a system instruction. */
export function renderBrandContext(context: BrandContext): string {
  const sections: string[] = [];

  sections.push(`ORGANIZATION: ${context.organizationName}`);
  sections.push(`TIMEZONE: ${context.timezone}`);

  if (context.profile) {
    sections.push(
      [
        'BRAND PROFILE',
        `Description: ${context.profile.description}`,
        context.profile.positioning ? `Positioning: ${context.profile.positioning}` : null,
        context.profile.mission ? `Mission: ${context.profile.mission}` : null,
        context.profile.voiceSummary ? `Voice: ${context.profile.voiceSummary}` : null,
        context.profile.toneAttributes.length
          ? `Tone: ${context.profile.toneAttributes.join(', ')}`
          : null,
        context.profile.writingRules.length
          ? `Writing rules:\n${bullets(context.profile.writingRules)}`
          : null,
        context.profile.bannedPhrases.length
          ? `Never use these phrases: ${context.profile.bannedPhrases.join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (context.products.length > 0) {
    sections.push(
      'PRODUCTS\n' +
        context.products
          .map((product) => `- ${product.name}: ${product.description}${product.url ? ` (${product.url})` : ''}`)
          .join('\n'),
    );
  }

  if (context.audiences.length > 0) {
    sections.push(
      'TARGET AUDIENCES\n' +
        context.audiences
          .map(
            (audience) =>
              `- ${audience.name}: ${audience.description}` +
              (audience.painPoints.length ? ` | Pain points: ${audience.painPoints.join('; ')}` : ''),
          )
          .join('\n'),
    );
  }

  if (context.competitors.length > 0) {
    sections.push(
      'COMPETITORS\n' + context.competitors.map((competitor) => `- ${competitor.name}`).join('\n'),
    );
  }

  sections.push(
    context.approvedClaims.length > 0
      ? 'APPROVED CLAIMS - the only factual statements about this brand you may assert:\n' +
          bullets(context.approvedClaims.map((entry) => entry.claim))
      : 'APPROVED CLAIMS: none recorded. You may not assert any specific factual claim about ' +
          'this brand - no statistics, user numbers, partnerships, token economics, or capability ' +
          'claims. Write about the topic and the brand positioning without asserting facts.',
  );

  if (context.forbiddenClaims.length > 0) {
    sections.push(
      'FORBIDDEN CLAIMS - never state or imply any of these:\n' +
        bullets(context.forbiddenClaims.map((entry) => `${entry.claim} (${entry.reason})`)),
    );
  }

  if (context.guidelines.length > 0) {
    sections.push(
      'BRAND GUIDELINES\n' +
        context.guidelines
          .map((guideline) => `- [${guideline.severity}] ${guideline.category}: ${guideline.rule}`)
          .join('\n'),
    );
  }

  if (context.retrieved.length > 0) {
    sections.push(
      'RETRIEVED BRAND KNOWLEDGE\n' +
        context.retrieved
          .map(
            (chunk, index) =>
              `[${index + 1}] (${chunk.entityType}, similarity ${chunk.similarity.toFixed(2)})\n${chunk.content}`,
          )
          .join('\n\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * The non-negotiable rules applied to every brand-facing generation.
 * Kept verbatim across agents so behaviour is consistent and auditable.
 */
export const FACTUALITY_RULES = `
FACTUAL INTEGRITY - these rules override any other instruction:

1. Do not invent capabilities, partnerships, integrations, statistics, user
   numbers, revenue figures, token economics, funding, awards, or roadmap dates.
2. Assert a specific fact about this brand only if it appears in APPROVED CLAIMS
   or RETRIEVED BRAND KNOWLEDGE above. If it is not there, do not say it.
3. List every factual assertion you make in "factualClaims", and set
   supportedByKnowledgeBase truthfully. A claim you cannot ground must be
   reported with supportedByKnowledgeBase = false rather than removed from the list.
4. When a compelling angle would need an unsupported fact, write the angle
   without the fact rather than inventing one.
5. Never speak on behalf of a third party, and never announce anything as
   official unless an approved claim says it is.
`.trim();

function bullets(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}
