import type { ReleaseEvent, ReleaseEventHandler } from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";

const handlers = new Set<ReleaseEventHandler>();

/** Registers a consumer such as a future webhook dispatcher; returns an unsubscribe function. */
export function onReleaseEvent(handler: ReleaseEventHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Delivers an event to every handler; a failing handler never fails the release change. */
export async function emitReleaseEvent(
  event: ReleaseEvent,
  level: string | undefined
): Promise<void> {
  const logger = createLogger(level, { service: "releases", repoId: event.repositoryId });
  logger.info("release:event", { type: event.type, releaseId: event.releaseId });
  for (const handler of handlers) {
    try {
      await handler(event);
    } catch {
      logger.warn("release:event-handler-failed", { type: event.type });
    }
  }
}
