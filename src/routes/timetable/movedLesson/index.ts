import { getLogger } from '@logtape/logtape';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { StatusCodes } from 'http-status-codes';
import { db } from '~/database';
import {
  classroom,
  dayDefinition,
  lesson,
  lessonCohortMTM,
  movedLesson,
  movedLessonLessonMTM,
  period,
} from '~/database/schema/timetable';
import type { SuccessResponse } from '~/utils/globals';
import {
  requireAuthentication,
  requireAuthorization,
} from '~/utils/middleware';
import { timetableFactory } from '../_factory';

const logger = getLogger(['chronos', 'substitutions']);

const ensurePeriodExists = async (periodId: string) => {
  const [existingPeriod] = await db
    .select({ periodId: period.id })
    .from(period)
    .where(eq(period.id, periodId));

  if (!existingPeriod) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: 'Invalid starting period provided',
    });
  }
};

const ensureDayDefinitionExists = async (dayId: string) => {
  const [existingDay] = await db
    .select({ dayId: dayDefinition.id })
    .from(dayDefinition)
    .where(eq(dayDefinition.id, dayId));

  if (!existingDay) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: 'Invalid starting day provided',
    });
  }
};

const ensureClassroomExists = async (classroomId: string) => {
  const [existingRoom] = await db
    .select({ classroomId: classroom.id })
    .from(classroom)
    .where(eq(classroom.id, classroomId));

  if (!existingRoom) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: 'Invalid classroom provided',
    });
  }
};

const ensureLessonsExist = async (lessonIds: string[]) => {
  const lessonRecords = await db
    .select({ lessonId: lesson.id })
    .from(lesson)
    .where(inArray(lesson.id, lessonIds));

  const foundLessonIds = new Set(lessonRecords.map(({ lessonId }) => lessonId));
  const missingLessonIds = lessonIds.filter(
    (lessonId) => !foundLessonIds.has(lessonId)
  );

  if (missingLessonIds.length > 0) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: `Invalid lesson ids provided: ${missingLessonIds.join(', ')}`,
    });
  }
};

const normalizeOptionalString = (
  value: unknown,
  label: string
): string | undefined => {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== 'string') {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: `${label} must be a string`,
    });
  }

  return value;
};

const normalizeOptionalStringArray = (
  value: unknown,
  label: string
): string[] | undefined => {
  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new HTTPException(StatusCodes.BAD_REQUEST, {
      message: `${label} must be an array`,
    });
  }

  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new HTTPException(StatusCodes.BAD_REQUEST, {
        message: `${label} must contain only strings`,
      });
    }

    return entry;
  });
};

const validateMovedLessonReferences = async (options: {
  startingPeriod?: unknown;
  startingDay?: unknown;
  room?: unknown;
  lessonIds?: unknown;
}) => {
  const { startingPeriod, startingDay, room, lessonIds } = options;

  const normalizedStartingPeriod = normalizeOptionalString(
    startingPeriod,
    'Starting period'
  );
  if (normalizedStartingPeriod) {
    await ensurePeriodExists(normalizedStartingPeriod);
  }

  const normalizedStartingDay = normalizeOptionalString(
    startingDay,
    'Starting day'
  );
  if (normalizedStartingDay) {
    await ensureDayDefinitionExists(normalizedStartingDay);
  }

  const normalizedRoom = normalizeOptionalString(room, 'Classroom');
  if (normalizedRoom) {
    await ensureClassroomExists(normalizedRoom);
  }

  const normalizedLessonIds = normalizeOptionalStringArray(
    lessonIds,
    'Lesson ids'
  );
  if (normalizedLessonIds && normalizedLessonIds.length > 0) {
    await ensureLessonsExist(normalizedLessonIds);
  }
};

export const getAllMovedLessons = timetableFactory.createHandlers(async (c) => {
  try {
    const movedLessons = await db
      .select({
        classroom,
        dayDefinition,
        lessons: sql<string[]>`COALESCE(
            ARRAY_AGG(${movedLessonLessonMTM.lessonId}) FILTER (WHERE ${movedLessonLessonMTM.lessonId} IS NOT NULL),
            ARRAY[]::text[]
          )`.as('lessons'),
        movedLesson,
        period,
      })
      .from(movedLesson)
      .leftJoin(period, eq(movedLesson.startingPeriod, period.id))
      .leftJoin(dayDefinition, eq(movedLesson.startingDay, dayDefinition.id))
      .leftJoin(classroom, eq(movedLesson.room, classroom.id))
      .leftJoin(
        movedLessonLessonMTM,
        eq(movedLesson.id, movedLessonLessonMTM.movedLessonId)
      )
      .groupBy(movedLesson.id, period.id, dayDefinition.id, classroom.id);

    return c.json<SuccessResponse>({
      data: movedLessons,
      success: true,
    });
  } catch (error) {
    logger.error('Error while fetching all moved lessons', { error });
    throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
      message: 'Failed to fetch all moved lessons',
    });
  }
});

export const getRelevantMovedLessons = timetableFactory.createHandlers(
  async (c) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);

      const movedLessons = await db
        .select({
          classroom,
          dayDefinition,
          lessons: sql<string[]>`COALESCE(
            ARRAY_AGG(${movedLessonLessonMTM.lessonId}) FILTER (WHERE ${movedLessonLessonMTM.lessonId} IS NOT NULL),
            ARRAY[]::text[]
          )`.as('lessons'),
          movedLesson,
          period,
        })
        .from(movedLesson)
        .leftJoin(period, eq(movedLesson.startingPeriod, period.id))
        .leftJoin(dayDefinition, eq(movedLesson.startingDay, dayDefinition.id))
        .leftJoin(classroom, eq(movedLesson.room, classroom.id))
        .leftJoin(
          movedLessonLessonMTM,
          eq(movedLesson.id, movedLessonLessonMTM.movedLessonId)
        )
        .where(gte(movedLesson.date, todayStr))
        .groupBy(movedLesson.id, period.id, dayDefinition.id, classroom.id);

      return c.json<SuccessResponse>({
        data: movedLessons,
        success: true,
      });
    } catch (error) {
      logger.error('Error while fetching relevant moved lessons', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to fetch relevant moved lessons',
      });
    }
  }
);

export const getMovedLessonsForCohort = timetableFactory.createHandlers(
  async (c) => {
    try {
      const cohortId = c.req.param('cohortId');

      if (!cohortId) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Cohort ID is required',
        });
      }

      const movedLessons = await db
        .select({
          classroom,
          dayDefinition,
          lessons: sql<string[]>`COALESCE(
            ARRAY_AGG(DISTINCT ${movedLessonLessonMTM.lessonId}) FILTER (WHERE ${movedLessonLessonMTM.lessonId} IS NOT NULL),
            ARRAY[]::text[]
          )`.as('lessons'),
          movedLesson,
          period,
        })
        .from(movedLesson)
        .leftJoin(period, eq(movedLesson.startingPeriod, period.id))
        .leftJoin(dayDefinition, eq(movedLesson.startingDay, dayDefinition.id))
        .leftJoin(classroom, eq(movedLesson.room, classroom.id))
        .leftJoin(
          movedLessonLessonMTM,
          eq(movedLesson.id, movedLessonLessonMTM.movedLessonId)
        )
        .leftJoin(lesson, eq(movedLessonLessonMTM.lessonId, lesson.id))
        .leftJoin(lessonCohortMTM, eq(lesson.id, lessonCohortMTM.lessonId))
        .where(eq(lessonCohortMTM.cohortId, cohortId))
        .groupBy(movedLesson.id, period.id, dayDefinition.id, classroom.id);

      return c.json<SuccessResponse>({
        data: movedLessons,
        success: true,
      });
    } catch (error) {
      logger.error('Error while fetching moved lessons for cohort', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to fetch moved lessons for cohort',
      });
    }
  }
);

export const getRelevantMovedLessonsForCohort = timetableFactory.createHandlers(
  async (c) => {
    try {
      const cohortId = c.req.param('cohortId');

      if (!cohortId) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Cohort ID is required',
        });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);

      const movedLessons = await db
        .select({
          classroom,
          dayDefinition,
          lessons: sql<string[]>`COALESCE(
            ARRAY_AGG(DISTINCT ${movedLessonLessonMTM.lessonId}) FILTER (WHERE ${movedLessonLessonMTM.lessonId} IS NOT NULL),
            ARRAY[]::text[]
          )`.as('lessons'),
          movedLesson,
          period,
        })
        .from(movedLesson)
        .leftJoin(period, eq(movedLesson.startingPeriod, period.id))
        .leftJoin(dayDefinition, eq(movedLesson.startingDay, dayDefinition.id))
        .leftJoin(classroom, eq(movedLesson.room, classroom.id))
        .leftJoin(
          movedLessonLessonMTM,
          eq(movedLesson.id, movedLessonLessonMTM.movedLessonId)
        )
        .leftJoin(lesson, eq(movedLessonLessonMTM.lessonId, lesson.id))
        .leftJoin(lessonCohortMTM, eq(lesson.id, lessonCohortMTM.lessonId))
        .where(
          and(
            eq(lessonCohortMTM.cohortId, cohortId),
            gte(movedLesson.date, todayStr)
          )
        )
        .groupBy(movedLesson.id, period.id, dayDefinition.id, classroom.id);

      return c.json<SuccessResponse>({
        data: movedLessons,
        success: true,
      });
    } catch (error) {
      logger.error('Error while fetching relevant moved lessons for cohort', {
        error,
      });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to fetch relevant moved lessons for cohort',
      });
    }
  }
);

export const createMovedLesson = timetableFactory.createHandlers(
  requireAuthentication,
  requireAuthorization('movedLesson:create'),
  async (c) => {
    try {
      const body = await c.req.json();
      const { startingPeriod, startingDay, room, date, lessonIds } = body;

      if (!date) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Date is required',
        });
      }

      await validateMovedLessonReferences({
        lessonIds,
        room,
        startingDay,
        startingPeriod,
      });

      const [newMovedLesson] = await db
        .insert(movedLesson)
        .values({
          date,
          id: crypto.randomUUID(),
          room,
          startingDay,
          startingPeriod,
        })
        .returning();

      if (
        lessonIds &&
        Array.isArray(lessonIds) &&
        lessonIds.length > 0 &&
        newMovedLesson
      ) {
        await db.insert(movedLessonLessonMTM).values(
          lessonIds.map((lessonId: string) => ({
            lessonId,
            movedLessonId: newMovedLesson.id,
          }))
        );
      }

      return c.json<SuccessResponse>(
        {
          data: newMovedLesson,
          success: true,
        },
        StatusCodes.CREATED
      );
    } catch (error) {
      logger.error(`Error while creating moved lesson: ${error}`, { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to create moved lesson',
      });
    }
  }
);

export const updateMovedLesson = timetableFactory.createHandlers(
  requireAuthentication,
  requireAuthorization('movedLesson:update'),
  async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json();
      const { startingPeriod, startingDay, room, date, lessonIds } = body;

      if (!id) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Moved lesson ID is required',
        });
      }

      await validateMovedLessonReferences({
        lessonIds,
        room,
        startingDay,
        startingPeriod,
      });

      const [updatedMovedLesson] = await db
        .update(movedLesson)
        .set({
          date: date !== undefined ? date : undefined,
          room: room !== undefined ? room : undefined,
          startingDay: startingDay !== undefined ? startingDay : undefined,
          startingPeriod:
            startingPeriod !== undefined ? startingPeriod : undefined,
        })
        .where(eq(movedLesson.id, id))
        .returning();

      if (!updatedMovedLesson) {
        throw new HTTPException(StatusCodes.NOT_FOUND, {
          message: 'Moved lesson not found',
        });
      }

      if (lessonIds !== undefined && Array.isArray(lessonIds)) {
        await db
          .delete(movedLessonLessonMTM)
          .where(eq(movedLessonLessonMTM.movedLessonId, id));

        if (lessonIds.length > 0) {
          await db.insert(movedLessonLessonMTM).values(
            lessonIds.map((lessonId: string) => ({
              lessonId,
              movedLessonId: id,
            }))
          );
        }
      }

      return c.json<SuccessResponse>({
        data: updatedMovedLesson,
        success: true,
      });
    } catch (error) {
      logger.error('Error while updating moved lesson', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to update moved lesson',
      });
    }
  }
);

export const deleteMovedLesson = timetableFactory.createHandlers(
  requireAuthentication,
  requireAuthorization('movedLesson:delete'),
  async (c) => {
    try {
      const id = c.req.param('id');

      if (!id) {
        throw new HTTPException(StatusCodes.BAD_REQUEST, {
          message: 'Moved lesson ID is required',
        });
      }

      const [deletedMovedLesson] = await db
        .delete(movedLesson)
        .where(eq(movedLesson.id, id))
        .returning();

      if (!deletedMovedLesson) {
        throw new HTTPException(StatusCodes.NOT_FOUND, {
          message: 'Moved lesson not found',
        });
      }

      return c.json<SuccessResponse>({
        data: deletedMovedLesson,
        success: true,
      });
    } catch (error) {
      logger.error('Error while deleting moved lesson', { error });
      throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
        message: 'Failed to delete moved lesson',
      });
    }
  }
);
