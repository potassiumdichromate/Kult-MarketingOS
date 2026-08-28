import type { Job } from 'bullmq';
import { chunkText } from '@kult/ai';
import type { WorkerContext } from '../context.js';
import { indexDocumentJob } from '../jobs.js';
import type { JobLogger } from '../logger.js';

/**
 * Knowledge base indexing.
 *
 * Chunking and embedding a long document is slow and rate-limited, which is why
 * it runs here rather than on the API request. The document's status reflects
 * reality throughout: PENDING, then PROCESSING, then INDEXED or FAILED with the
 * reason, so the knowledge screen never shows a document as ready when its
 * content is not actually retrievable.
 */
export async function processIndexDocument(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ chunks: number }> {
  const payload = indexDocumentJob.parse(job.data);

  const document = await context.prisma.sourceDocument.findUnique({
    where: { id: payload.sourceDocumentId },
    select: { id: true, organizationId: true, title: true, status: true },
  });

  if (!document || document.organizationId !== payload.organizationId) {
    throw new Error(`Source document ${payload.sourceDocumentId} was not found.`);
  }
  if (document.status === 'INDEXED') {
    return { chunks: 0 };
  }

  await context.prisma.sourceDocument.update({
    where: { id: document.id },
    data: { status: 'PROCESSING', error: null },
  });

  try {
    const chunks = chunkText(payload.text);
    if (chunks.length === 0) {
      await context.prisma.sourceDocument.update({
        where: { id: document.id },
        data: {
          status: 'FAILED',
          error: 'No usable text could be extracted from this document.',
        },
      });
      return { chunks: 0 };
    }

    const written = await context.knowledge.index(
      payload.organizationId,
      chunks.map((content, index) => ({
        entityType: 'SOURCE_DOCUMENT' as const,
        sourceDocumentId: document.id,
        content,
        chunkIndex: index,
      })),
    );

    await context.prisma.sourceDocument.update({
      where: { id: document.id },
      data: { status: 'INDEXED', chunkCount: written, error: null },
    });

    log.info(
      { sourceDocumentId: document.id, chunks: chunks.length, written },
      'Indexed source document',
    );

    return { chunks: written };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await context.prisma.sourceDocument.update({
      where: { id: document.id },
      data: { status: 'FAILED', error: message.slice(0, 2_000) },
    });

    // Rethrown so BullMQ retries: embedding failures are usually transient
    // rate limits, and the document status already reflects the failure.
    throw error;
  }
}
