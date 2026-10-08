import { z } from 'zod';

/** Core event names present in every funnel version. Configs may allow more (e.g. `recommendation_expanded` in v3). */
export const CORE_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;
export type CoreEventType = (typeof CORE_EVENTS)[number];

export const UtmSchema = z
  .object({
    utm_source: z.string().max(200).optional(),
    utm_medium: z.string().max(200).optional(),
    utm_campaign: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
  })
  .partial();
export type Utm = z.infer<typeof UtmSchema>;

const uuidLike = z.string().min(8).max(128);

/**
 * Event as sent by the client. The client is NOT trusted for version/variant/utm:
 * the server takes them from the session the event belongs to.
 */
export const IncomingEventSchema = z.object({
  event_id: uuidLike,
  session_id: uuidLike,
  event_type: z.string().min(1).max(64),
  client_timestamp: z.string().datetime({ offset: true }),
  step_id: z.string().max(128).optional().nullable(),
  properties: z.record(z.unknown()).optional(),
});
export type IncomingEvent = z.infer<typeof IncomingEventSchema>;

export type EventStatus = 'accepted' | 'duplicate' | 'rejected';

export interface EventResult {
  event_id: string | null;
  status: EventStatus;
  reason?: string;
}

export interface EventsBatchResponse {
  results: EventResult[];
  summary: Record<EventStatus, number>;
}

/** Event as stored and as exposed by analytics APIs. */
export interface StoredEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  step_id: string | null;
  funnel_version: string;
  variant: string;
  client_timestamp: string;
  server_timestamp: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  properties: Record<string, unknown>;
}
