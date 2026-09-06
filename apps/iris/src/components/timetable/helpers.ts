import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { getDayOrder, getLocalizedWeekdayName } from '@/utils/date-locale';
import type {
  DayColumn,
  FilterType,
  LessonItem,
  PeriodItem,
  TimeSlot,
  TimetableViewModel,
} from './types';

dayjs.extend(customParseFormat);

/** Format time string to HH:MM */
export const toHHMM = (t: string | undefined | null): string =>
  (t ?? '00:00:00').slice(0, 5);

/** Color palette for subject-based coloring — 12-color rainbow */
const ACCENT_COLORS = [
  { bg: 'bg-blue-50/50 dark:bg-blue-900/20', border: 'border-blue-500/50' },
  {
    bg: 'bg-emerald-50/50 dark:bg-emerald-900/20',
    border: 'border-emerald-500/50',
  },
  { bg: 'bg-amber-50/50 dark:bg-amber-900/20', border: 'border-amber-500/50' },
  {
    bg: 'bg-purple-50/50 dark:bg-purple-900/20',
    border: 'border-purple-500/50',
  },
  { bg: 'bg-rose-50/50 dark:bg-rose-900/20', border: 'border-rose-500/50' },
  { bg: 'bg-cyan-50/50 dark:bg-cyan-900/20', border: 'border-cyan-500/50' },
  { bg: 'bg-teal-50/50 dark:bg-teal-900/20', border: 'border-teal-500/50' },
  {
    bg: 'bg-orange-50/50 dark:bg-orange-900/20',
    border: 'border-orange-500/50',
  },
  {
    bg: 'bg-indigo-50/50 dark:bg-indigo-900/20',
    border: 'border-indigo-500/50',
  },
  { bg: 'bg-pink-50/50 dark:bg-pink-900/20', border: 'border-pink-500/50' },
  { bg: 'bg-lime-50/50 dark:bg-lime-900/20', border: 'border-lime-500/50' },
  { bg: 'bg-sky-50/50 dark:bg-sky-900/20', border: 'border-sky-500/50' },
] as const;

/** Get consistent color classes for a subject */
export const getSubjectColor = (
  name: string,
  userColors?: Record<string, number>
): { bg: string; border: string } => {
  // Check user preference first
  if (userColors) {
    const idx = userColors[name];
    if (idx !== undefined && idx >= 0 && idx < ACCENT_COLORS.length) {
      return ACCENT_COLORS[idx] ?? { bg: '', border: '' };
    }
  }

  // Fall back to hash-based default
  let sum = 0;
  for (const ch of name) {
    sum += ch.codePointAt(0) ?? 0;
  }
  return (
    ACCENT_COLORS[Math.abs(sum) % ACCENT_COLORS.length] ?? {
      bg: '',
      border: '',
    }
  );
};

/** Format teacher display name */
const formatTeacher = (teacher: LessonItem['teachers'][number]): string => {
  if (!teacher) {
    return '';
  }
  if ('short' in teacher && teacher.short) {
    return teacher.short;
  }
  if ('name' in teacher && teacher.name) {
    return teacher.name;
  }
  const first = (teacher as Record<string, string>).firstName ?? '';
  const last = (teacher as Record<string, string>).lastName ?? '';
  return `${first} ${last}`.trim();
};

/** Format teachers list */
export const formatTeachers = (teachers: LessonItem['teachers']): string =>
  (teachers ?? []).map(formatTeacher).filter(Boolean).join(', ');

/** Format room display */
const formatRoom = (room: LessonItem['classrooms'][number]): string => {
  if (!room) {
    return '';
  }
  return room.short ?? room.name ?? '';
};

/** Format rooms list */
export const formatRooms = (rooms: LessonItem['classrooms']): string =>
  (rooms ?? []).map(formatRoom).filter(Boolean).join(', ');

/** Format cohort display */
const formatCohort = (cohort: LessonItem['cohorts'][number]): string => {
  if (!cohort) {
    return '';
  }
  return cohort.short ?? cohort.name ?? '';
};

/** Format cohorts list */
export const formatCohorts = (cohorts: LessonItem['cohorts']): string =>
  (cohorts ?? []).map(formatCohort).filter(Boolean).join(', ');

export type GroupDisplay = 'highlight' | 'hide' | 'none';
export type GroupEmphasis = 'mine' | 'dim' | 'neutral';

/** Determine emphasis for a lesson based on selected groups and divisions */
export const getLessonGroupEmphasis = (
  lesson: LessonItem,
  selectedGroupIds?: Set<string>,
  selectedDivisionTags?: Set<string>
): GroupEmphasis => {
  const hasSelection = (selectedGroupIds?.size ?? 0) > 0;

  if (!hasSelection) {
    return 'neutral';
  }

  const groups = lesson.groups ?? [];

  if (groups.length === 0) {
    return 'neutral';
  }

  if (groups.some((group) => selectedGroupIds?.has(group.id))) {
    return 'mine';
  }

  if (
    groups.some((group) => {
      const tag = group.divisionTag;
      return tag !== null && selectedDivisionTags?.has(tag);
    })
  ) {
    return 'dim';
  }

  return 'neutral';
};

/** Filter lessons based on group display settings */
export const filterLessonsForGroupDisplay = (
  lessons: LessonItem[],
  groupDisplay: GroupDisplay,
  selectedGroupIds?: Set<string>,
  selectedDivisionTags?: Set<string>
): LessonItem[] => {
  if (groupDisplay !== 'hide') {
    return lessons;
  }

  return lessons.filter(
    (lesson) =>
      getLessonGroupEmphasis(lesson, selectedGroupIds, selectedDivisionTags) !==
      'dim'
  );
};

/** Process a single lesson into the grid structure */
const processLesson = (
  lesson: LessonItem,
  dayMap: Map<string, { sortOrder: number; shortName?: string }>,
  timeMap: Map<
    string,
    { start: dayjs.Dayjs; end: dayjs.Dayjs; period: number }
  >,
  grid: Map<string, { lessons: LessonItem[] }>
) => {
  const dayName = lesson.day?.name ?? '';
  const dayShort = lesson.day?.short;

  // Normalise to the 0-6 Mon-Sun scale used by getDayOrder so the sort order
  // is consistent with WEEKDAY_STUBS regardless of the backend raw index.
  const dayOrder = getDayOrder(dayName, dayShort);

  const currentDay = dayMap.get(dayName);
  if (!currentDay || currentDay.sortOrder > dayOrder) {
    dayMap.set(dayName, { shortName: dayShort, sortOrder: dayOrder });
  }

  // Parse start and end times from lesson period
  const startTimeStr = toHHMM(lesson.period?.startTime);
  const endTimeStr = toHHMM(lesson.period?.endTime);
  const periodNumber = lesson.period?.period ?? 0;

  const start = dayjs(startTimeStr, 'HH:mm');
  const end =
    endTimeStr && endTimeStr !== '00:00'
      ? dayjs(endTimeStr, 'HH:mm')
      : start.add(45, 'minute');

  // Store time slot with actual end time and real period number
  const existing = timeMap.get(startTimeStr);
  if (!existing || end.isAfter(existing.end)) {
    timeMap.set(startTimeStr, { end, period: periodNumber, start });
  }

  // Group lessons by day-time cell
  const key = `${dayName}-${startTimeStr}`;
  const cell = grid.get(key) ?? { lessons: [] };
  cell.lessons.push(lesson);
  grid.set(key, cell);
};

/**
 * Canonical Mon-Fri stubs - sortOrders here are on the same 0-6 scale as
 * getDayOrder (0 = Monday ... 6 = Sunday), matching what processLesson stores.
 */
const WEEKDAY_STUBS = [
  { dayName: 'Monday', dayShort: 'Mon', sortOrder: 0 },
  { dayName: 'Tuesday', dayShort: 'Tue', sortOrder: 1 },
  { dayName: 'Wednesday', dayShort: 'Wed', sortOrder: 2 },
  { dayName: 'Thursday', dayShort: 'Thu', sortOrder: 3 },
  { dayName: 'Friday', dayShort: 'Fri', sortOrder: 4 },
] as const;

/** Build view model from lessons array */
export const buildViewModel = (
  lessons: LessonItem[],
  language: string | undefined,
  canonicalPeriods?: PeriodItem[]
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: builds complete timetable grid with canonical periods, synthetic weekday columns, and lesson grouping
): TimetableViewModel => {
  // Collect unique days and time slots
  const dayMap = new Map<string, { sortOrder: number; shortName?: string }>();
  const timeMap = new Map<
    string,
    { start: dayjs.Dayjs; end: dayjs.Dayjs; period: number }
  >();
  const grid = new Map<string, { lessons: LessonItem[] }>();

  // Pre-populate timeMap with canonical period definitions (period >= 1) so that
  // regular periods without lessons for the current selection still appear as
  // empty rows. Period 0 ("nulladik óra") is intentionally excluded here — it
  // is only shown when the selected entity actually has a lesson there.
  if (canonicalPeriods?.length) {
    for (const cp of canonicalPeriods) {
      if (cp.period === 0) {
        continue;
      }
      const startTimeStr = toHHMM(cp.startTime);
      const endTimeStr = toHHMM(cp.endTime);
      const start = dayjs(startTimeStr, 'HH:mm');
      const end =
        endTimeStr && endTimeStr !== '00:00'
          ? dayjs(endTimeStr, 'HH:mm')
          : start.add(45, 'minute');
      // Only add if not already present - lessons will override via processLesson
      if (!timeMap.has(startTimeStr)) {
        timeMap.set(startTimeStr, { end, period: cp.period, start });
      }
    }
  }

  for (const lesson of lessons) {
    processLesson(lesson, dayMap, timeMap, grid);
  }

  // Build day columns from lessons
  const days: DayColumn[] = Array.from(dayMap.entries()).map(
    ([name, dayMeta]) => ({
      key: name,
      label: getLocalizedWeekdayName(name, dayMeta.shortName, language, 'long'),
      sortOrder: dayMeta.sortOrder,
    })
  );

  // Always show Mon-Fri: insert a synthetic column for any weekday that has
  // no lessons, using the same 0-4 scale so deduplication is reliable.
  const presentOrders = new Set(days.map((d) => d.sortOrder));
  for (const { dayName, dayShort, sortOrder } of WEEKDAY_STUBS) {
    if (!presentOrders.has(sortOrder)) {
      days.push({
        key: dayName,
        label: getLocalizedWeekdayName(dayName, dayShort, language, 'long'),
        sortOrder,
      });
    }
  }

  days.sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, language)
  );

  // Use the actual period number from the DB (not the array index) so the
  // label is correct even when early periods have no lessons.
  const timeSlots = Array.from(timeMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, times]) => ({
      end: times.end,
      index: times.period,
      start: times.start,
    }));

  // Cut off empty rows at the top and bottom: keep only the span of slots that
  // actually hold a lesson on at least one day, instead of rendering the full
  // canonical period range with empty rows before/after the last lesson.
  const occupiedKeys = new Set<string>();
  for (const [key, cell] of grid) {
    if ((cell.lessons?.length ?? 0) > 0) {
      occupiedKeys.add(key);
    }
  }
  const isOccupied = (slot: TimeSlot): boolean => {
    const hhmm = slot.start.format('HH:mm');
    return days.some((day) => occupiedKeys.has(`${day.key}-${hhmm}`));
  };
  let first = 0;
  let last = timeSlots.length - 1;
  while (first <= last && !isOccupied(timeSlots[first] as TimeSlot)) {
    first += 1;
  }
  while (last >= first && !isOccupied(timeSlots[last] as TimeSlot)) {
    last -= 1;
  }
  const trimmedTimeSlots =
    first <= last ? timeSlots.slice(first, last + 1) : timeSlots;

  return { days, grid, timeSlots: trimmedTimeSlots };
};

/** Get filter label for i18n */
export const filterLabelFor = (
  activeFilter: FilterType,
  t: (key: string) => string
): string => {
  const labels: Record<FilterType, string> = {
    class: 'timetable.filterByClass',
    classroom: 'timetable.filterByClassroom',
    teacher: 'timetable.filterByTeacher',
  };
  return t(labels[activeFilter]);
};
