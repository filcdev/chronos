import { eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { StatusCodes } from 'http-status-codes';
import { db } from '~/database';
import {
  classroom,
  cohort,
  dayDefinition,
  lesson,
  lessonCohortMTM,
  period,
  subject,
  teacher,
} from '~/database/schema/timetable';
import type { SuccessResponse } from '~/utils/globals';
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

    const lessonRows = await db
      .select({ lesson })
      .from(lesson)
      .innerJoin(lessonCohortMTM, eq(lesson.id, lessonCohortMTM.lessonId))
      .where(eq(lessonCohortMTM.cohortId, cohortId));

    const lessons = lessonRows.map((r) => r.lesson);

    if (lessons.length === 0) {
      return c.json<SuccessResponse>({ success: true, data: [] });
    }

    const subjectIds = Array.from(new Set(lessons.map((l) => l.subjectId)));
    const dayIds = Array.from(new Set(lessons.map((l) => l.dayDefinitionId)));
    const periodIds = Array.from(new Set(lessons.map((l) => l.periodId)));
    const teacherIds = Array.from(
      new Set(
        lessons.flatMap((l) =>
          Array.isArray(l.teacherIds) ? l.teacherIds : []
        )
      )
    );
    const classroomIds = Array.from(
      new Set(
        lessons.flatMap((l) =>
          Array.isArray(l.classroomIds) ? l.classroomIds : []
        )
      )
    );

    const [subjects, days, periods, teachers, classrooms] = await Promise.all([
      db.select().from(subject).where(inArray(subject.id, subjectIds)),
      db.select().from(dayDefinition).where(inArray(dayDefinition.id, dayIds)),
      db.select().from(period).where(inArray(period.id, periodIds)),
      teacherIds.length
        ? db.select().from(teacher).where(inArray(teacher.id, teacherIds))
        : Promise.resolve([] as (typeof teacher.$inferSelect)[]),
      classroomIds.length
        ? db.select().from(classroom).where(inArray(classroom.id, classroomIds))
        : Promise.resolve([] as (typeof classroom.$inferSelect)[]),
    ]);

    const subjMap = new Map(subjects.map((s) => [s.id, s] as const));
    const dayMap = new Map(days.map((d) => [d.id, d] as const));
    const periodMap = new Map(periods.map((p) => [p.id, p] as const));
    const teacherMap = new Map(teachers.map((t) => [t.id, t] as const));
    const classroomMap = new Map(classrooms.map((cr) => [cr.id, cr] as const));

    const enriched = lessons.map((l) => {
      const tIds = (
        Array.isArray(l.teacherIds) ? l.teacherIds : []
      ) as string[];
      const cIds = (
        Array.isArray(l.classroomIds) ? l.classroomIds : []
      ) as string[];

      return {
        id: l.id,
        subject: (() => {
          const s = subjMap.get(l.subjectId);
          return s ? { id: s.id, name: s.name, short: s.short } : null;
        })(),
        teachers: tIds
          .map((id) => teacherMap.get(id))
          .filter(Boolean)
          .map((t) => ({
            id: (t as (typeof teachers)[number]).id,
            name: `${(t as (typeof teachers)[number]).firstName} ${(t as (typeof teachers)[number]).lastName}`,
            short: (t as (typeof teachers)[number]).short,
          })),
        classrooms: cIds
          .map((id) => classroomMap.get(id))
          .filter(Boolean)
          .map((cr) => ({
            id: (cr as (typeof classrooms)[number]).id,
            name: (cr as (typeof classrooms)[number]).name,
            short: (cr as (typeof classrooms)[number]).short,
          })),
        day: (() => {
          const d = dayMap.get(l.dayDefinitionId);
          return d;
        })(),
        period: (() => {
          const p = periodMap.get(l.periodId);
          return p
            ? {
                id: p.id,
                startTime: String(p.startTime),
                endTime: String(p.endTime),
                period: p.period,
              }
            : null;
        })(),
        weeksDefinitionId: l.weeksDefinitionId,
        termDefinitionId: l.termDefinitionId,
        periodsPerWeek: l.periodsPerWeek,
      };
    });

    return c.json<SuccessResponse>({ success: true, data: enriched });
  }
);
