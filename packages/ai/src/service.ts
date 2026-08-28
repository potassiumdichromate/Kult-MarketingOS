import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import type { AIProviderConfig } from '@kult/config';
import { AIProviderError, NotConfiguredError } from '@kult/shared';

/**
 * The single gateway to the model provider.
 *
 * Agents never construct an OpenAI client. They call this service, which owns:
 *  - model selection by tier, so no model name is hardcoded across the codebase
 *  - structured output enforcement through Zod + Structured Outputs
 *  - bounded retries that distinguish transient from permanent failures
 *  - token accounting returned to the caller for persistence on AgentExecution
 *
 * Verified against the openai SDK v7:
 *   client.responses.parse({ model, input, instructions, text: { format } })
 *     -> ParsedResponse with `output_parsed`
 *   client.responses.stream({ ... })      -> async-iterable ResponseStream
 *   client.embeddings.create({ model, input, dimensions })
 *   client.images.generate({ model, prompt, size })
 *   web search tool: { type: 'web_search' }
 */

export type ModelTier = 'default' | 'fast' | 'reasoning';

export interface AIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  usage: AIUsage;
  latencyMs: number;
  /** Citations gathered from hosted web search, when the tool was used. */
  citations: Citation[];
  responseId: string;
}

export interface Citation {
  url: string;
  title?: string;
}

export interface StructuredRequest<S extends z.ZodType> {
  /** Name for the JSON schema. Must be a stable identifier. */
  schemaName: string;
  schema: S;
  instructions: string;
  input: string;
  tier?: ModelTier;
  /** Enables the provider's hosted web search tool for this call. */
  webSearch?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  /** Correlates provider-side logs with our execution records. */
  metadata?: Record<string, string>;
}

export class AIService {
  private readonly client: OpenAI;

  constructor(private readonly config: AIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      timeout: config.timeoutMs,
      // Retries are handled here so they can be logged and bounded per tier.
      maxRetries: 0,
    });
  }

  model(tier: ModelTier = 'default'): string {
    return this.config.models[tier];
  }

  get webSearchEnabled(): boolean {
    return this.config.webSearchEnabled;
  }

  get imageGenerationEnabled(): boolean {
    return Boolean(this.config.models.image);
  }

  /**
   * Generates a value conforming to `schema`.
   *
   * Structured Outputs makes the provider enforce the schema, and the SDK parses
   * it. A refusal or an unparseable response raises AIProviderError; it is never
   * salvaged with regex, and a null parse is never coerced into a partial object.
   */
  async generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<StructuredResult<z.infer<S>>> {
    const model = this.model(request.tier ?? 'default');
    const useWebSearch = Boolean(request.webSearch) && this.config.webSearchEnabled;

    const started = Date.now();
    const response = await this.withRetries(model, () =>
      this.client.responses.parse({
        model,
        instructions: request.instructions,
        input: request.input,
        text: { format: zodTextFormat(request.schema, request.schemaName) },
        ...(useWebSearch ? { tools: [{ type: 'web_search' as const }] } : {}),
        ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }),
    );

    const parsed = response.output_parsed;
    if (parsed === null || parsed === undefined) {
      throw new AIProviderError(
        'The model returned no parseable structured output for ' + request.schemaName + '.',
        // A retry is worthwhile: this is usually a truncated or refused generation.
        true,
        { model, responseId: response.id, status: response.status },
      );
    }

    return {
      data: parsed as z.infer<S>,
      model,
      usage: extractUsage(response.usage),
      latencyMs: Date.now() - started,
      citations: extractCitations(response),
      responseId: response.id,
    };
  }

  /**
   * Streams a free-form assistant reply, for the copilot.
   *
   * `onDelta` receives text increments. The resolved value is the complete text
   * plus accounting, so the caller can persist the finished message.
   */
  async streamText(request: {
    instructions: string;
    input: string;
    tier?: ModelTier;
    webSearch?: boolean;
    maxOutputTokens?: number;
    onDelta: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<{ text: string; model: string; usage: AIUsage; citations: Citation[] }> {
    const model = this.model(request.tier ?? 'default');
    const useWebSearch = Boolean(request.webSearch) && this.config.webSearchEnabled;

    const stream = this.client.responses.stream({
      model,
      instructions: request.instructions,
      input: request.input,
      ...(useWebSearch ? { tools: [{ type: 'web_search' as const }] } : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    });

    if (request.signal) {
      request.signal.addEventListener('abort', () => stream.abort(), { once: true });
    }

    let text = '';
    try {
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta ?? '';
          text += delta;
          request.onDelta(delta);
        }
      }
    } catch (error) {
      throw this.toAIError(model, error);
    }

    const final = await stream.finalResponse();
    return {
      text: text.length > 0 ? text : (final.output_text ?? ''),
      model,
      usage: extractUsage(final.usage),
      citations: extractCitations(final),
    };
  }

  /** Embeds text for the brand knowledge base. Batched by the caller. */
  async embed(inputs: string[]): Promise<{ vectors: number[][]; model: string; usage: AIUsage }> {
    if (inputs.length === 0) return { vectors: [], model: this.config.models.embedding, usage: {} };

    const model = this.config.models.embedding;
    const response = await this.withRetries(model, () =>
      this.client.embeddings.create({
        model,
        input: inputs,
        dimensions: this.config.embeddingDimensions,
      }),
    );

    // The API may return items out of order; index is authoritative.
    const vectors: number[][] = new Array(inputs.length);
    for (const item of response.data) {
      vectors[item.index] = item.embedding;
    }

    return {
      vectors,
      model,
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        totalTokens: response.usage?.total_tokens,
      },
    };
  }

  /**
   * Generates an image. Throws NotConfiguredError when no image model is set,
   * which is how the UI knows to disable media generation rather than offering
   * a button that cannot work.
   */
  async generateImage(request: {
    prompt: string;
    size?: '1024x1024' | '1024x1536' | '1536x1024';
  }): Promise<{ buffer: Buffer; mimeType: string; model: string }> {
    const model = this.config.models.image;
    if (!model) {
      throw new NotConfiguredError('AI image generation', ['OPENAI_IMAGE_MODEL']);
    }

    const response = await this.withRetries(model, () =>
      this.client.images.generate({
        model,
        prompt: request.prompt,
        size: request.size ?? '1024x1024',
        n: 1,
      }),
    );

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw new AIProviderError('The image model returned no image data.', true, { model });
    }
    return { buffer: Buffer.from(b64, 'base64'), mimeType: 'image/png', model };
  }

  /**
   * Bounded retry around provider calls.
   *
   * Retries only what can plausibly succeed on a second attempt: rate limits,
   * server errors, timeouts, and connection failures. Authentication, permission,
   * and request-shape errors fail immediately.
   */
  private async withRetries<T>(model: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const aiError = this.toAIError(model, error);
        if (!aiError.retryable || attempt === this.config.maxRetries) throw aiError;

        // Exponential backoff with jitter, so parallel agents do not resynchronise.
        const backoff = Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 250;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw this.toAIError(model, lastError);
  }

  private toAIError(model: string, error: unknown): AIProviderError {
    if (error instanceof AIProviderError) return error;

    if (error instanceof OpenAI.APIError) {
      const status = error.status ?? 0;
      const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
      return new AIProviderError(
        `The model provider returned ${status || 'an error'}: ${error.message}`,
        retryable,
        { model, status, type: error.type, code: error.code },
      );
    }

    if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIUserAbortError) {
      return new AIProviderError('Could not reach the model provider.', true, { model });
    }

    return new AIProviderError(
      error instanceof Error ? error.message : 'An unknown model provider error occurred.',
      true,
      { model },
    );
  }
}

function extractUsage(usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined | null): AIUsage {
  if (!usage) return {};
  return {
    ...(usage.input_tokens !== undefined ? { promptTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { completionTokens: usage.output_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
  };
}

/**
 * Pulls real URLs out of web-search annotations.
 *
 * Only provider-supplied annotations count as citations. URLs the model merely
 * wrote into its prose are not treated as evidence, because those can be
 * invented; annotations correspond to pages the search tool actually retrieved.
 */
function extractCitations(response: { output?: unknown }): Citation[] {
  const citations = new Map<string, Citation>();

  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;

      for (const annotation of annotations) {
        if (typeof annotation !== 'object' || annotation === null) continue;
        const record = annotation as { type?: string; url?: string; title?: string };
        if (record.type === 'url_citation' && typeof record.url === 'string') {
          citations.set(record.url, {
            url: record.url,
            ...(record.title ? { title: record.title } : {}),
          });
        }
      }
    }
  }

  return [...citations.values()];
}
