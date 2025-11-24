import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '~/database';
import {
  classroom,
  cohort,
  dayDefinition,
  lesson,
  lessonCohortMTM,
  period,
  subject,
  substitution,
  substitutionLessonMTM,
  teacher,
} from '~/database/schema/timetable';

type LessonRow = typeof lesson.$inferSelect;
type SubjectRow = typeof subject.$inferSelect;
type DayRow = typeof dayDefinition.$inferSelect;
type PeriodRow = typeof period.$inferSelect;
type TeacherRow = typeof teacher.$inferSelect;
type ClassroomRow = typeof classroom.$inferSelect;
type SubstitutionRow = typeof substitution.$inferSelect;

export async function loadEnrichedLessonsForCohort(cohortId: string) {
  const lessonRows = (await db
    .select({ lesson })
    .from(lesson)
    .innerJoin(lessonCohortMTM, eq(lesson.id, lessonCohortMTM.lessonId))
    .where(eq(lessonCohortMTM.cohortId, cohortId))) as { lesson: LessonRow }[];

  const lessons: LessonRow[] = lessonRows.map((r) => r.lesson);

  if (lessons.length === 0) {
    return [];
  }

  const subjectIds = Array.from(new Set(lessons.map((l) => l.subjectId)));
  const dayIds = Array.from(new Set(lessons.map((l) => l.dayDefinitionId)));
  const periodIds = Array.from(new Set(lessons.map((l) => l.periodId)));
  const teacherIds = Array.from(
    new Set(
      lessons.flatMap((l) => (Array.isArray(l.teacherIds) ? l.teacherIds : []))
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
    subjectIds.length
      ? (db
          .select()
          .from(subject)
          .where(inArray(subject.id, subjectIds)) as Promise<SubjectRow[]>)
      : Promise.resolve([] as SubjectRow[]),
    dayIds.length
      ? (db
          .select()
          .from(dayDefinition)
          .where(inArray(dayDefinition.id, dayIds)) as Promise<DayRow[]>)
      : Promise.resolve([] as DayRow[]),
    periodIds.length
      ? (db
          .select()
          .from(period)
          .where(inArray(period.id, periodIds)) as Promise<PeriodRow[]>)
      : Promise.resolve([] as PeriodRow[]),
    teacherIds.length
      ? (db
          .select()
          .from(teacher)
          .where(inArray(teacher.id, teacherIds)) as Promise<TeacherRow[]>)
      : Promise.resolve([] as TeacherRow[]),
    classroomIds.length
      ? (db
          .select()
          .from(classroom)
          .where(inArray(classroom.id, classroomIds)) as Promise<
          ClassroomRow[]
        >)
      : Promise.resolve([] as ClassroomRow[]),
  ]);

  const subjMap = new Map(subjects.map((s) => [s.id, s] as const));
  const dayMap = new Map(days.map((d) => [d.id, d] as const));
  const periodMap = new Map(periods.map((p) => [p.id, p] as const));
  const teacherMap = new Map(teachers.map((t) => [t.id, t] as const));
  const classroomMap = new Map(classrooms.map((cr) => [cr.id, cr] as const));

  const enriched = lessons.map((l) => {
    const tIds = (Array.isArray(l.teacherIds) ? l.teacherIds : []) as string[];
    const cIds = (
      Array.isArray(l.classroomIds) ? l.classroomIds : []
    ) as string[];

    return {
      classrooms: cIds
        .map((id) => classroomMap.get(id))
        .filter((cr): cr is ClassroomRow => Boolean(cr))
        .map((cr) => ({ id: cr.id, name: cr.name, short: cr.short })),
      day: dayMap.get(l.dayDefinitionId) ?? null,
      id: l.id,
      period: (() => {
        const p = periodMap.get(l.periodId);
        return p
          ? {
              endTime: String(p.endTime),
              id: p.id,
              period: p.period,
              startTime: String(p.startTime),
            }
          : null;
      })(),
      periodsPerWeek: l.periodsPerWeek,
      subject: (() => {
        const s = subjMap.get(l.subjectId);
        return s ? { id: s.id, name: s.name, short: s.short } : null;
      })(),
      teachers: tIds
        .map((id) => teacherMap.get(id))
        .filter((t): t is TeacherRow => Boolean(t))
        .map((t) => ({
          id: t.id,
          name: `${t.firstName} ${t.lastName}`,
          short: t.short,
        })),
      termDefinitionId: l.termDefinitionId,
      weeksDefinitionId: l.weeksDefinitionId,
    };
  });

  return enriched;
}

export async function loadSubstitutionsForCohort(cohortId: string) {
  const today = new Date().toISOString().split('T')[0];

  const substitutions = (await db
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
    .leftJoin(lesson, eq(substitutionLessonMTM.lessonId, lesson.id))
    .leftJoin(lessonCohortMTM, eq(lesson.id, lessonCohortMTM.lessonId))
    .leftJoin(cohort, eq(lessonCohortMTM.cohortId, cohort.id))
    .where(
      and(gte(substitution.date, today as string), eq(cohort.id, cohortId))
    )
    .groupBy(substitution.id, teacher.id)) as Array<{
    lessons: string[];
    substitution: SubstitutionRow;
    teacher: TeacherRow | null;
  }>;

  return substitutions;
}
