import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { StatusCodes } from 'http-status-codes';
import { db } from '~/database';
import { cohort } from '~/database/schema/timetable';
import { loadEnrichedLessonsForCohort } from '~/database/timetable-loader';
import type { SuccessResponse } from '~/utils/globals';
import timetableCache from '~/utils/timetable-cache';
import { timetableFactory } from '../_factory';

export const getLessonsForCohort = timetableFactory.createHandlers(
  async (c) => {
    const cohortId = c.req.param('cohort_id');
    if (!cohortId) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: 'Missing cohort_id',
      });
    }

    const [existingCohort] = await db
      .select()
      .from(cohort)
      .where(eq(cohort.id, cohortId))
      .limit(1);

    if (!existingCohort) {
      throw new HTTPException(StatusCodes.NOT_FOUND, {
        message: 'Cohort not found',
      });
    }
    // Try cache first
    const cached = timetableCache.getCachedLessonsForCohort(cohortId);
    if (cached) {
      return c.json<SuccessResponse>({ data: cached, success: true });
    }

    const enriched = await loadEnrichedLessonsForCohort(cohortId);
    // set cache
    timetableCache.setLessonsForCohort(cohortId, enriched);

    return c.json<SuccessResponse>({ data: enriched, success: true });
  }
);
