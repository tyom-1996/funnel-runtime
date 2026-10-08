import type { Answers } from './conditions.js';
import type { ResolvedFunnel } from './funnel.js';
import type { Utm } from './events.js';

/** Response of POST /api/sessions and GET /api/sessions/:id */
export interface SessionResponse {
  session: {
    id: string;
    funnelVersion: string;
    variant: string;
    variantSource: 'assigned' | 'override';
    currentStepId: string | null;
    answers: Answers;
    utm: Utm;
    createdAt: string;
    expiresAt: string;
  };
  funnel: ResolvedFunnel;
}

export interface VersionSummary {
  version: string;
  funnelId: string;
  name: string | null;
  status: 'draft' | 'published' | 'archived';
  isActive: boolean;
  createdAt: string;
  publishedAt: string | null;
  experimentId: string;
  stepCount: number;
  sessionCount: number;
}

export interface PublicationLogEntry {
  id: number;
  action: 'publish' | 'rollback';
  fromVersion: string | null;
  toVersion: string;
  createdAt: string;
}

export interface AnalyticsFilters {
  version?: string;
  variant?: string;
  utm_campaign?: string;
}

export interface StepMetric {
  stepId: string;
  title: string;
  type: string;
  /** Position in the variant's step sequence. */
  index: number;
  viewed: number;
  completed: number;
  /** Sessions whose furthest step is this one and that never reached the result. */
  droppedHere: number;
  /** viewed(this) / sessions that got at least as far as the previous position; null for the first step. Never exceeds 1. */
  conversionFromPrev: number | null;
  /** viewed(this) / started */
  reachRate: number;
  /** droppedHere / viewed */
  dropRate: number;
}

export interface FunnelMetrics {
  version: string;
  variant: string;
  started: number;
  reachedResult: number;
  ctaClicked: number;
  /** reachedResult / started */
  completionRate: number;
  /** ctaClicked / reachedResult */
  ctaCtr: number;
  /** ctaClicked / started — the primary A/B metric */
  ctaPerStarted: number;
  steps: StepMetric[];
  /** Sessions that have events but whose version/variant is unknown to the current config set. */
  unknownStepIds: string[];
}

export interface OverviewMetrics {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  completionRate: number;
  ctaCtr: number;
  ctaPerStarted: number;
  totalEvents: number;
  duplicateProtectedEvents: number;
}

export interface AnalyticsResponse {
  filters: AnalyticsFilters;
  overview: OverviewMetrics;
  /** One entry per (version, variant) that has sessions, after filters. */
  segments: FunnelMetrics[];
  /** Aggregates per version (variants merged). */
  byVersion: Array<Pick<FunnelMetrics, 'version' | 'started' | 'reachedResult' | 'ctaClicked' | 'completionRate' | 'ctaCtr' | 'ctaPerStarted'>>;
  /** Aggregates per variant (versions merged). */
  byVariant: Array<Pick<FunnelMetrics, 'variant' | 'started' | 'reachedResult' | 'ctaClicked' | 'completionRate' | 'ctaCtr' | 'ctaPerStarted'>>;
  campaigns: string[];
  versions: string[];
  variants: string[];
}
