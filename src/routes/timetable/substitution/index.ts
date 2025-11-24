import { getLogger } from '@logtape/logtape';
import { eq, gte, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { StatusCodes } from 'http-status-codes';
import { db } from '~/database';
import {
  lesson,
  lessonCohortMTM,
  substitution,
  substitutionLessonMTM,
  teacher,
} from '~/database/schema/timetable';
import { loadSubstitutionsForCohort } from '~/database/timetable-loader';
import { pub } from '~/mqtt/client';
import { env } from '~/utils/environment';
import type { SuccessResponse } from '~/utils/globals';
import {
  requireAuthentication,
  requireAuthorization,
} from '~/utils/middleware';
import timetableCache from '~/utils/timetable-cache';
import { timetableFactory } from '../_factory';

const logger = getLogger(['chronos', 'substitutions']);

// Helper: invalidate cohorts for given lesson ids (local cache + publish MQTT)
async function invalidateCohortsForLessonIds(lessonIds: string[] | undefined) {
  if (!lessonIds || lessonIds.length === 0) {
    return;
  }
  try {
    const cohortRows = await db
      .select({ cohortId: lessonCohortMTM.cohortId })
      .from(lessonCohortMTM)
      .where(inArray(lessonCohortMTM.lessonId, lessonIds));

    const cohortIds = cohortRows
      .map(
        (r: { cohortId?: string; cohort_id?: string }) =>
          r.cohortId ?? r.cohort_id
      )
      .filter(Boolean) as string[];

    for (const cid of cohortIds) {
      timetableCache.invalidateCohort(cid);
    }

    try {
      pub(
        'chronos/timetable/invalidate',
        JSON.stringify({ cohortIds, ts: Date.now() })
      );
    } catch (err) {
      logger.warn('Failed to publish mqtt invalidation', { err });
    }
  } catch (err) {
    logger.warn('Failed to invalidate cohorts', { err });
  }
}

export const getAllSubstitutions = timetableFactory.createHandlers(
  requireAuthentication,
  async (c) => {
    try {
      const substitutions = await db
        .select({
          lessons: sql<string[]>`COALESCE(
            ARRAY_AGG(${substitutionLessonMTM.lessonId}) FILTER (WHERE ${substitutionLessonMTM.lessonId} IS NOT NULL),
            ARRAY[]::text[]
          )`.as('lessons'),
          substitution,
          teacher,
        })
        .from(substitution)
        .leftJoin(teacher, eq(substitution.substituter, teacher.id))
        .leftJoin(
          substitutionLessonMTM,
          eq(substitution.id, substitutionLessonMTM.substitutionId)
        )
        .groupBy(substitution.id, teacher.id);

      return c.json<SuccessResponse>({
        data: substitutions,
        success: true,
      });
    } catch (error) {
      logger.error('Error while fetching all substitutions', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to fetch all substitutions',
      });
    }
  }
);

export const getRelevantSubstitutions = timetableFactory.createHandlers(
  requireAuthentication,
  async (c) => {
    try {
      const today = new Date().toISOString().split('T')[0];

      const substitutions = await db
        .select({
          lessons: sql<string[]>`COALESCE(
            ARRAY_AGG(${substitutionLessonMTM.lessonId}) FILTER (WHERE ${substitutionLessonMTM.lessonId} IS NOT NULL),
            ARRAY[]::text[]
          )`.as('lessons'),
          substitution,
          teacher,
        })
        .from(substitution)
        .leftJoin(teacher, eq(substitution.substituter, teacher.id))
        .leftJoin(
          substitutionLessonMTM,
          eq(substitution.id, substitutionLessonMTM.substitutionId)
        )
        .where(gte(substitution.date, today as string))
        .groupBy(substitution.id, teacher.id);

      return c.json<SuccessResponse>({
        data: substitutions,
        success: true,
      });
    } catch (error) {
      logger.error('Error while fetching substitutions', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to fetch substitutions',
      });
    }
  }
);

export const getRelevantSubstitutionsForCohort =
  timetableFactory.createHandlers(requireAuthentication, async (c) => {
    const cohortId = c.req.param('cohortId');

    if (!cohortId) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: 'Cohort ID is required',
      });
    }

    // no-op

    try {
      const cached = timetableCache.getCachedSubstitutionsForCohort(cohortId);
      if (cached) {
        return c.json<SuccessResponse>({
          data: {
            cohortId,
            substitutions: cached,
          },
          success: true,
        });
      }

      const substitutions = await loadSubstitutionsForCohort(cohortId);

      // populate cache with latest known substitutions (best-effort)
      try {
        timetableCache.setSubstitutionsForCohort(cohortId, substitutions);
      } catch (_err) {
        // noop
      }

      return c.json<SuccessResponse>({
        data: {
          cohortId,
          substitutions,
        },
        success: true,
      });
    } catch (error) {
      logger.error('Error while fetching substitutions for cohort', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to fetch substitutions for cohort',
      });
    }
  });

export const createSubstitution = timetableFactory.createHandlers(
  requireAuthentication,
  requireAuthorization('substitution:create'),
  async (c) => {
    const body = (await c.req.json()) as {
      date: string;
      lessonIds: string[];
      substituter?: string;
    };

    const { lessonIds, date, substituter } = body;

    if (!(lessonIds && date)) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: 'Missing required fields: lessonIds and date are required.',
      });
    }

    const dateAsDateType = new Date(date);
    if (Number.isNaN(dateAsDateType.getTime())) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: 'Invalid date format.',
      });
    }

    const lessonCount = await db.$count(lesson, inArray(lesson.id, lessonIds));

    if (lessonCount !== lessonIds.length) {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: `attempted to substitute non-existent lesson(s), wanted: ${lessonIds.length}, got: ${lessonCount}`,
      });
    }

    const result = await db.transaction(async (tx) => {
      const [insertedSubstitution] = await tx
        .insert(substitution)
        .values({
          date,
          id: crypto.randomUUID(),
          substituter,
        })
        .returning();

      if (!insertedSubstitution) {
        throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
          cause:
            env.mode === 'development'
              ? 'No substitution returned from insert query'
              : undefined,
          message: 'Failed to create substitution.',
        });
      }

      // Insert the many-to-many relationships
      const mtmValues = lessonIds.map((lessonId) => ({
        lessonId,
        substitutionId: insertedSubstitution.id,
      }));

      await tx.insert(substitutionLessonMTM).values(mtmValues);

      return insertedSubstitution;
    });

    // Invalidate local cache for cohorts that are affected by these lessons.
    await invalidateCohortsForLessonIds(lessonIds);

    return c.json<SuccessResponse>({
      data: result,
      success: true,
    });
  }
);

export const updateSubstitution = timetableFactory.createHandlers(
  requireAuthentication,
  requireAuthorization('substitution:update'),
  async (c) => {
    try {
      const id = c.req.param('id');
      const body = (await c.req.json()) as {
        date?: string;
        lessonIds?: string[];
        substituter?: string;
      };

      if (!id) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Substitution ID is required',
        });
      }

      const existingSubstitution = await db
        .select()
        .from(substitution)
        .where(eq(substitution.id, id))
        .limit(1);

      if (existingSubstitution.length === 0) {
        throw new HTTPException(StatusCodes.NOT_FOUND, {
          message: 'Substitution not found',
        });
      }

      if (body.date) {
        const dateAsDate = new Date(body.date);
        if (Number.isNaN(dateAsDate.getTime())) {
          throw new HTTPException(StatusCodes.BAD_REQUEST, {
            message: 'Invalid date format',
          });
        }
      }

      if (body.lessonIds) {
        const lessonCount = await db.$count(
          lesson,
          inArray(lesson.id, body.lessonIds)
        );
        if (lessonCount !== body.lessonIds.length) {
          throw new HTTPException(StatusCodes.BAD_REQUEST, {
            message: `Some lessons don't exist, wanted: ${body.lessonIds.length}, found: ${lessonCount}`,
          });
        }
      }

      // Use a transaction to update the substitution and the many-to-many relationships
      const updatedSubstitution = await db.transaction(async (tx) => {
        // Update the substitution (excluding lessonIds)
        const updateData = { ...body };
        updateData.lessonIds = undefined;

        const [updated] = await tx
          .update(substitution)
          .set(updateData)
          .where(eq(substitution.id, id))
          .returning();

        // If lessonIds were provided, update the many-to-many relationships
        if (body.lessonIds) {
          // Delete existing relationships
          await tx
            .delete(substitutionLessonMTM)
            .where(eq(substitutionLessonMTM.substitutionId, id));

          // Insert new relationships
          const mtmValues = body.lessonIds.map((lessonId) => ({
            lessonId,
            substitutionId: id,
          }));

          await tx.insert(substitutionLessonMTM).values(mtmValues);
        }

        return updated;
      });

      // Invalidate cohorts impacted by this substitution update. Determine
      // lesson ids either from the request body (if provided) or from the
      // existing many-to-many table.
      try {
        let lessonIdsForSub: string[] = [];
        if (body.lessonIds) {
          lessonIdsForSub = body.lessonIds;
        } else {
          const rows = await db
            .select({ lessonId: substitutionLessonMTM.lessonId })
            .from(substitutionLessonMTM)
            .where(eq(substitutionLessonMTM.substitutionId, id));
          lessonIdsForSub = rows
            .map(
              (r: { lessonId?: string; lesson_id?: string }) =>
                r.lessonId ?? r.lesson_id
            )
            .filter(Boolean) as string[];
        }

        if (lessonIdsForSub.length) {
          await invalidateCohortsForLessonIds(lessonIdsForSub);
        }
      } catch (err) {
        logger.warn('Failed to invalidate cohorts after updateSubstitution', {
          err,
        });
      }

      return c.json<SuccessResponse>({
        data: updatedSubstitution,
        success: true,
      });
    } catch (error) {
      logger.error('Error while updating substitution', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        cause:
          env.mode === 'development' ? (error as Error).message : undefined,
        message: 'Failed to update substitution',
      });
    }
  }
);

export const deleteSubstitution = timetableFactory.createHandlers(
  requireAuthentication,
  requireAuthorization('substitution:delete'),
  async (c) => {
    try {
      const id = c.req.param('id');

      if (!id) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Substitution ID is required',
        });
      }

      const existingSubstitution = await db
        .select()
        .from(substitution)
        .where(eq(substitution.id, id))
        .limit(1);

      if (existingSubstitution.length === 0) {
        throw new HTTPException(StatusCodes.NOT_FOUND, {
          message: 'Substitution not found',
        });
      }

      // Determine affected lesson ids before delete so we can invalidate
      // corresponding cohort caches after the deletion.
      const lessonRows = await db
        .select({ lessonId: substitutionLessonMTM.lessonId })
        .from(substitutionLessonMTM)
        .where(eq(substitutionLessonMTM.substitutionId, id));

      const lessonIds = lessonRows
        .map(
          (r: { lessonId?: string; lesson_id?: string }) =>
            r.lessonId ?? r.lesson_id
        )
        .filter(Boolean) as string[];

      const [deletedSubstitution] = await db
        .delete(substitution)
        .where(eq(substitution.id, id))
        .returning();

      try {
        if (lessonIds.length) {
          await invalidateCohortsForLessonIds(lessonIds);
        }
      } catch (err) {
        logger.warn('Failed to invalidate cohorts after deleteSubstitution', {
          err,
        });
      }

      return c.json<SuccessResponse>({
        data: deletedSubstitution,
        success: true,
      });
    } catch (error) {
      logger.error('Error while deleting substitution', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        cause:
          env.mode === 'development' ? (error as Error).message : undefined,
        message: 'Failed to delete substitution',
      });
    }
  }
);
