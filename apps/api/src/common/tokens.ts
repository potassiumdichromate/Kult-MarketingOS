/**
 * Injection tokens for values that are plain objects rather than classes.
 * Centralised so a provider and its consumer can never drift apart on a string.
 */
export const APP_CONFIG = 'APP_CONFIG';
export const PRISMA = 'PRISMA';
export const SECRET_BOX = 'SECRET_BOX';
export const STORAGE = 'STORAGE';
export const SOCIAL_REGISTRY = 'SOCIAL_REGISTRY';
export const RESEARCH_REGISTRY = 'RESEARCH_REGISTRY';
export const AI_SERVICE = 'AI_SERVICE';
export const KNOWLEDGE_BASE = 'KNOWLEDGE_BASE';
export const BRAND_LOADER = 'BRAND_LOADER';
export const OPENAI_CLIENT = 'OPENAI_CLIENT';
