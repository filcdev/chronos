import { getLogger } from '@logtape/logtape';
import { db } from '~/database';
import { cohort } from '~/database/schema/timetable';
import {
  loadEnrichedLessonsForCohort,
  loadSubstitutionsForCohort,
} from '~/database/timetable-loader';
import { registerMqttHandler } from '~/mqtt/client';

const logger = getLogger(['chronos', 'timetable', 'cache']);

type LessonsValue = Awaited<ReturnType<typeof loadEnrichedLessonsForCohort>>;
type SubstitutionsValue = Awaited<
  ReturnType<typeof loadSubstitutionsForCohort>
>;

type CohortCacheValue = {
  lessons?: LessonsValue;
  substitutions?: SubstitutionsValue;
  loadedAt: number;
};

const CACHE_TTL_MS = Number(process.env.TIMETABLE_CACHE_TTL_MS ?? 30_000);

const map = new Map<string, CohortCacheValue>();
const inFlight = new Map<string, Promise<void>>();

// metrics
const metrics = {
  hits: 0,
  invalidations: 0,
  misses: 0,
  preload: 0,
  refreshes: 0,
};

const now = () => Date.now();

export function getCachedLessonsForCohort(
  cohortId: string
): LessonsValue | null {
  const entry = map.get(cohortId);
  if (!entry) {
    return null;
  }
  if (!entry.lessons) {
    return null;
  }
  if (now() - entry.loadedAt > CACHE_TTL_MS) {
    return null;
  }
  metrics.hits += 1;
  return entry.lessons;
}

export function setLessonsForCohort(cohortId: string, lessons: LessonsValue) {
  const existing = map.get(cohortId) ?? { loadedAt: now() };
  existing.lessons = lessons;
  existing.loadedAt = now();
  map.set(cohortId, existing);
}

export function getCachedSubstitutionsForCohort(
  cohortId: string
): SubstitutionsValue | null {
  const entry = map.get(cohortId);
  if (!entry) {
    return null;
  }
  if (!entry.substitutions) {
    return null;
  }
  if (now() - entry.loadedAt > CACHE_TTL_MS) {
    return null;
  }
  metrics.hits += 1;
  return entry.substitutions;
}

export function setSubstitutionsForCohort(
  cohortId: string,
  substitutions: SubstitutionsValue
) {
  const existing = map.get(cohortId) ?? { loadedAt: now() };
  existing.substitutions = substitutions;
  existing.loadedAt = now();
  map.set(cohortId, existing);
}

export function invalidateCohort(cohortId: string) {
  map.delete(cohortId);
  metrics.invalidations += 1;
}

const PRELOAD_CONCURRENCY = 10;

export async function preloadAllCohorts() {
  logger.info('Preloading all cohorts into timetable cache');
  const cohortIds = await db
    .select({ id: cohort.id })
    .from(cohort)
    .then((rows: { id: string }[]) => rows.map((r) => r.id));

  for (let i = 0; i < cohortIds.length; i += PRELOAD_CONCURRENCY) {
    const batch = cohortIds.slice(i, i + PRELOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (id: string) => {
        try {
          const lessons = await loadEnrichedLessonsForCohort(id);
          setLessonsForCohort(id, lessons);
        } catch (err) {
          logger.warn('Failed to preload lessons for cohort', { err, id });
        }
        try {
          const subs = await loadSubstitutionsForCohort(id);
          setSubstitutionsForCohort(id, subs);
        } catch (err) {
          logger.warn('Failed to preload substitutions for cohort', {
            err,
            id,
          });
        }
        metrics.preload += 1;
      })
    );
  }

  logger.info('Preload complete', { count: cohortIds.length });
}

export async function initializeTimetableCache(opts?: { preload?: boolean }) {
  if (opts?.preload) {
    await preloadAllCohorts();
  }
  // Start background refresh loop
  startBackgroundRefresh();
}

// Background refresh
const REFRESH_INTERVAL_MS = Number(
  process.env.TIMETABLE_CACHE_REFRESH_MS ?? 60_000
);
let refreshInterval: ReturnType<typeof setInterval> | null = null;

function refreshCohort(cohortId: string) {
  if (inFlight.has(cohortId)) {
    return;
  }
  const p = (async () => {
    try {
      metrics.refreshes += 1;
      try {
        const lessons = await loadEnrichedLessonsForCohort(cohortId);
        if (lessons) {
          setLessonsForCohort(cohortId, lessons);
        }
      } catch (e) {
        logger.warn('background refresh lessons failed', { cohortId, e });
      }

      try {
        const subs = await loadSubstitutionsForCohort(cohortId);
        if (subs) {
          setSubstitutionsForCohort(cohortId, subs);
        }
      } catch (e) {
        logger.warn('background refresh subs failed', { cohortId, e });
      }
    } finally {
      inFlight.delete(cohortId);
    }
  })();
  inFlight.set(cohortId, p);
  return p;
}

export function startBackgroundRefresh() {
  if (refreshInterval) {
    return;
  }
  refreshInterval = setInterval(() => {
    try {
      for (const [cohortId, entry] of map.entries()) {
        if (now() - entry.loadedAt > CACHE_TTL_MS) {
          const p = refreshCohort(cohortId);
          if (p) {
            p.catch(() => {
              /* ignore refresh errors */
            });
          }
        }
      }
    } catch (err) {
      logger.warn('background refresh loop failed', { err });
    }
  }, REFRESH_INTERVAL_MS);
}

export function stopBackgroundRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// MQTT invalidation handling
registerMqttHandler('chronos/timetable/invalidate', async (_topic, payload) => {
  try {
    const msg = JSON.parse(payload.toString()) as {
      cohortIds?: string[];
      cohortId?: string;
      refresh?: boolean;
    };
    const ids = msg.cohortIds ?? (msg.cohortId ? [msg.cohortId] : []);
    if (!ids.length) {
      return;
    }
    for (const id of ids) {
      if (msg.refresh) {
        await refreshCohort(id);
      } else {
        invalidateCohort(id);
      }
    }
  } catch (err) {
    logger.warn('invalid mqtt invalidation payload', { err });
  }
});

export function getMetrics() {
  return { ...metrics };
}

export function stopTimetableCache() {
  stopBackgroundRefresh();
}

export default {
  getCachedLessonsForCohort,
  getCachedSubstitutionsForCohort,
  initializeTimetableCache,
  invalidateCohort,
  preloadAllCohorts,
  setLessonsForCohort,
  setSubstitutionsForCohort,
};
