import { pdf } from '@react-pdf/renderer';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { CalendarX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type z from 'zod';
import { FilterBar } from '@/components/timetable/filter-bar';
import { TimetableGrid } from '@/components/timetable/grid';
import {
  buildViewModel,
  filterLessonsForGroupDisplay,
} from '@/components/timetable/helpers';
import { TimetablePDF } from '@/components/timetable/pdf/document';
import { PrintDialog } from '@/components/timetable/print-dialog';
import { TimetableCardView } from '@/components/timetable/secondary';
import type { SecondaryTimetableHeader } from '@/components/timetable/secondary/types';
import type {
  FilterType,
  LessonItem,
  PeriodItem,
  SelectionsType,
  TimetableItem,
  TimetableViewModel,
} from '@/components/timetable/types';
import { Empty } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useTimetableGroupDisplay } from '@/hooks/timetable-groups';
import {
  useClassrooms,
  useLatestValidTimetable,
  useTeachers,
  useTimetableCohorts,
  useTimetableLessons,
  useTimetablePeriods,
  useTimetables,
  useTimetableUserSettings,
} from '@/hooks/timetable-public';
import { Route, type searchSchema } from '@/routes/_public/index';
import { useApiMutation } from '@/utils/api';
import { authClient } from '@/utils/authentication';
import { api } from '@/utils/hc';
import { queryKeys } from '@/utils/query-keys';

// Helpers
const getActiveSelectionId = (
  filter: FilterType,
  selections: SelectionsType
) => {
  switch (filter) {
    case 'class':
      return selections.class;
    case 'teacher':
      return selections.teacher;
    case 'classroom':
      return selections.classroom;
    default:
      return null;
  }
};

/**
 * Derive the header info for the secondary (paper-like) timetable card. Only
 * the class code is shown in the grid's top-left corner cell.
 */
const buildCardHeader = (selectionLabel: string): SecondaryTimetableHeader => ({
  classCode: selectionLabel,
});

type TimetableCardRender = {
  header: SecondaryTimetableHeader;
  language: string | undefined;
  lessons: LessonItem[];
  periods: PeriodItem[];
};

type TimetableGridRender = {
  activeFilter: FilterType;
  groupDisplay: 'highlight' | 'hide' | 'none';
  model: TimetableViewModel;
  handleColorChange?: (subject: string, colorIndex: number) => void;
  isAuthenticated: boolean;
  selectedDivisionTags: Set<string>;
  selectedGroupIds: Set<string>;
  userColors: Record<string, number>;
};

/** Pick the on-screen timetable body: the secondary card view or the grid. */
const renderTimetableBody = (
  view: 'grid' | 'card',
  card: TimetableCardRender,
  grid: TimetableGridRender
) =>
  view === 'card' ? (
    <TimetableCardView
      header={card.header}
      language={card.language}
      lessons={card.lessons}
      periods={card.periods}
    />
  ) : (
    <TimetableGrid
      activeFilter={grid.activeFilter}
      groupDisplay={grid.groupDisplay}
      model={grid.model}
      onColorChange={grid.isAuthenticated ? grid.handleColorChange : undefined}
      selectedDivisionTags={grid.selectedDivisionTags}
      selectedGroupIds={grid.selectedGroupIds}
      userColors={grid.userColors}
    />
  );

// Component
export function TimetableView() {
  const search = Route.useSearch();
  const { i18n, t } = useTranslation();
  const { data: session, isPending } = authClient.useSession();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  const isAuthenticated = !isPending && !!session;

  // Fetch user settings for class colors (authenticated users only)
  const settingsQuery = useTimetableUserSettings(isAuthenticated);
  const userColors = isAuthenticated
    ? (settingsQuery.data?.timetableClassColors ?? {})
    : {};

  // Mutation to save class color
  const colorMutation = useApiMutation({
    mutationFn: async ({
      subject,
      colorIndex,
    }: {
      subject: string;
      colorIndex: number;
    }) => {
      const newColors = { ...userColors, [subject]: colorIndex };
      const res = await api.notifications.settings.$patch({
        json: { timetableClassColors: newColors },
      });
      if (!res) {
        throw new Error('Failed to save color');
      }
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notifications.settings(),
      });
    },
  });

  const handleColorChange = useCallback(
    (subject: string, colorIndex: number) => {
      colorMutation.mutate({ colorIndex, subject });
    },
    [colorMutation]
  );

  // Timetable query (all timetables)
  const timetablesQuery = useTimetables();

  // Expired timetables stay in the database, but are hidden from the public
  // selector. Current and upcoming timetables remain selectable.
  const visibleTimetables = useMemo(() => {
    const today = dayjs().format('YYYY-MM-DD');

    return (timetablesQuery.data ?? []).filter(
      (item: TimetableItem) => !item.validTo || item.validTo >= today
    );
  }, [timetablesQuery.data]);

  // The backend is the source of truth for the currently active timetable.
  const latestValidTimetableQuery = useLatestValidTimetable();

  const latestValidTimetableId = latestValidTimetableQuery.data?.id ?? null;

  // Selected timetable — initialised from URL param, else latestValid
  const [selectedTimetableId, setSelectedTimetableId] = useState<string | null>(
    search.timetable ?? null
  );

  // Once we know the latest valid, set it as default if nothing is selected
  useEffect(() => {
    if (!(timetablesQuery.data && latestValidTimetableId)) {
      return;
    }

    const selectedIsVisible =
      selectedTimetableId !== null &&
      visibleTimetables.some((item) => item.id === selectedTimetableId);

    if (!selectedIsVisible) {
      setSelectedTimetableId(latestValidTimetableId);
    }
  }, [
    timetablesQuery.data,
    visibleTimetables,
    selectedTimetableId,
    latestValidTimetableId,
  ]);

  // Queries
  const cohortsQuery = useTimetableCohorts(selectedTimetableId);

  const teachersQuery = useTeachers();

  const classroomsQuery = useClassrooms();

  const periodsQuery = useTimetablePeriods(selectedTimetableId);

  // State
  const [activeFilter, setActiveFilter] = useState<FilterType>(() => {
    if (search.cohort) {
      return 'class';
    }
    if (search.teacher) {
      return 'teacher';
    }
    if (search.room) {
      return 'classroom';
    }
    return 'class';
  });
  const [selections, setSelections] = useState<SelectionsType>({
    class: null,
    classroom: null,
    teacher: null,
  });
  const [initialized, setInitialized] = useState(false);

  const activeSelectionId = getActiveSelectionId(activeFilter, selections);

  // Fetch lessons
  const lessonsQuery = useTimetableLessons(
    activeFilter,
    activeSelectionId,
    selectedTimetableId
  );

  // Group highlighting applies to a signed-in student viewing their own class.
  const showGroupHandling =
    isAuthenticated &&
    activeFilter === 'class' &&
    selections.class !== null &&
    selections.class === session?.user?.cohortId;
  const { groupDisplay, selectedDivisionTags, selectedGroupIds } =
    useTimetableGroupDisplay(
      showGroupHandling ? selections.class : null,
      showGroupHandling,
      settingsQuery.data?.timetableGroupDisplay
    );

  // Initialize from URL or defaults
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO
  useEffect(() => {
    const allDataLoaded =
      cohortsQuery.data && teachersQuery.data && classroomsQuery.data;

    if (!allDataLoaded || initialized || isPending) {
      return;
    }

    // Validate search params against available data
    const cohortClass =
      search.cohort && cohortsQuery.data.some((c) => c.id === search.cohort)
        ? search.cohort
        : null;

    const cohortTeacher =
      search.teacher &&
      teachersQuery.data.some((teacher) => teacher.id === search.teacher)
        ? search.teacher
        : null;

    const cohortClassroom =
      search.room && classroomsQuery.data.some((c) => c.id === search.room)
        ? search.room
        : null;

    if (cohortClass) {
      setActiveFilter('class');
      setSelections((s) => ({ ...s, class: cohortClass }));
    } else if (cohortTeacher) {
      setActiveFilter('teacher');
      setSelections((s) => ({ ...s, teacher: cohortTeacher }));
    } else if (cohortClassroom) {
      setActiveFilter('classroom');
      setSelections((s) => ({ ...s, classroom: cohortClassroom }));
    } else {
      const userClassId = session?.user?.cohortId ?? null;
      const userDefault = cohortsQuery.data?.find(
        (cohort) => cohort.id === userClassId
      )?.id;
      const firstCohort = cohortsQuery.data[0]?.id ?? null;
      const fallbackClass = userDefault ?? firstCohort;
      setActiveFilter('class');
      setSelections((s) => ({ ...s, class: fallbackClass }));
    }

    setInitialized(true);
  }, [
    cohortsQuery.data,
    teachersQuery.data,
    classroomsQuery.data,
    session,
    isPending,
    initialized,
    search.cohort,
    search.teacher,
    search.room,
  ]);

  // Set default selection when filter changes
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO
  useEffect(() => {
    if (!initialized) {
      return;
    }

    const firstCohort = cohortsQuery.data?.[0];
    const firstTeacher = teachersQuery.data?.[0];
    const firstClassroom = classroomsQuery.data?.[0];

    switch (activeFilter) {
      case 'class':
        if (!selections.class && firstCohort) {
          setSelections((s) => ({ ...s, class: firstCohort.id }));
        }
        break;
      case 'teacher':
        if (!selections.teacher && firstTeacher) {
          setSelections((s) => ({ ...s, teacher: firstTeacher.id }));
        }
        break;
      case 'classroom':
        if (!selections.classroom && firstClassroom) {
          setSelections((s) => ({ ...s, classroom: firstClassroom.id }));
        }
        break;
      default:
        break;
    }
  }, [
    initialized,
    activeFilter,
    cohortsQuery.data,
    teachersQuery.data,
    classroomsQuery.data,
    selections.class,
    selections.classroom,
    selections.teacher,
  ]);

  // Reset class selection when timetable changes (cohorts are timetable-scoped)
  const [prevTimetableId, setPrevTimetableId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedTimetableId && selectedTimetableId !== prevTimetableId) {
      if (prevTimetableId !== null) {
        setSelections((s) => ({ ...s, class: null }));
        setInitialized(false);
      }
      setPrevTimetableId(selectedTimetableId);
    }
  }, [selectedTimetableId, prevTimetableId]);

  // Sync selection to URL
  useEffect(() => {
    if (activeSelectionId) {
      const searchParams: z.Infer<typeof searchSchema> = {
        cohort: undefined,
        room: undefined,
        teacher: undefined,
        timetable: selectedTimetableId ?? undefined,
        view: search.view,
      };

      const paramKey = `${activeFilter}` as 'cohort' | 'teacher' | 'room';
      searchParams[paramKey] = activeSelectionId;
      navigate({
        replace: true,
        search: () => searchParams,
      });
    }
  }, [
    activeFilter,
    activeSelectionId,
    selectedTimetableId,
    navigate,
    search.view,
  ]);

  const model = useMemo(
    () =>
      buildViewModel(
        (lessonsQuery.data ?? []) as LessonItem[],
        i18n.language,
        (periodsQuery.data ?? []) as PeriodItem[]
      ),
    [lessonsQuery.data, periodsQuery.data, i18n.language]
  );

  const cardLessons = useMemo(
    () =>
      filterLessonsForGroupDisplay(
        (lessonsQuery.data ?? []) as LessonItem[],
        groupDisplay,
        selectedGroupIds,
        selectedDivisionTags
      ),
    [lessonsQuery.data, groupDisplay, selectedGroupIds, selectedDivisionTags]
  );

  const [printDialogOpen, setPrintDialogOpen] = useState(false);

  const getSelectionLabel = (): string => {
    switch (activeFilter) {
      case 'class':
        return (
          cohortsQuery.data?.find((c) => c.id === selections.class)?.name ?? ''
        );
      case 'teacher': {
        const teacher = teachersQuery.data?.find(
          (entry) => entry.id === selections.teacher
        );
        if (!teacher) {
          return '';
        }
        return `${teacher.firstName} ${teacher.lastName}`.trim();
      }
      case 'classroom':
        return (
          classroomsQuery.data?.find((c) => c.id === selections.classroom)
            ?.name ?? ''
        );
      default:
        return '';
    }
  };

  // Secondary (paper-like) view: the class code shown in the corner cell.
  const view = search.view ?? 'grid';
  const cardHeader = buildCardHeader(getSelectionLabel());

  const handleViewChange = (nextView: 'grid' | 'card') => {
    navigate({
      replace: true,
      search: () => ({
        cohort: search.cohort,
        room: search.room,
        teacher: search.teacher,
        timetable: search.timetable,
        view: nextView,
      }),
    });
  };

  const handleGeneratePdf = async (blackAndWhite: boolean): Promise<void> => {
    const timetableName =
      timetablesQuery.data?.find((entry) => entry.id === selectedTimetableId)
        ?.name ?? '';
    const label = getSelectionLabel();
    const generatedAt = new Date().toLocaleDateString(i18n.language, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const blob = await pdf(
      <TimetablePDF
        activeFilter={activeFilter}
        blackAndWhite={blackAndWhite}
        generatedAt={generatedAt}
        label={label}
        model={model as TimetableViewModel}
        timetableName={timetableName}
      />
    ).toBlob();

    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  const getSelectorLoading = () => {
    switch (activeFilter) {
      case 'class':
        return cohortsQuery.isLoading;
      case 'teacher':
        return teachersQuery.isLoading;
      case 'classroom':
        return classroomsQuery.isLoading;
      default:
        return false;
    }
  };

  const selectorLoading = getSelectorLoading();

  const isLoading =
    selectorLoading || lessonsQuery.isLoading || !activeSelectionId;
  const hasError =
    cohortsQuery.error ||
    teachersQuery.error ||
    classroomsQuery.error ||
    lessonsQuery.error;

  const timetableContent = renderTimetableBody(
    view,
    {
      header: cardHeader,
      language: i18n.language,
      lessons: cardLessons,
      periods: (periodsQuery.data ?? []) as PeriodItem[],
    },
    {
      activeFilter,
      groupDisplay,
      handleColorChange,
      isAuthenticated,
      model,
      selectedDivisionTags,
      selectedGroupIds,
      userColors,
    }
  );

  return (
    <div className="flex grow flex-col items-center p-4">
      <div className="flex w-full min-w-0 max-w-7xl flex-col gap-4">
        <FilterBar
          activeFilter={activeFilter}
          classrooms={classroomsQuery.data}
          cohorts={cohortsQuery.data}
          disabled={isLoading}
          onFilterChange={setActiveFilter}
          onPrint={() => setPrintDialogOpen(true)}
          onSelectClass={(id) => setSelections((s) => ({ ...s, class: id }))}
          onSelectRoom={(id) => setSelections((s) => ({ ...s, classroom: id }))}
          onSelectTeacher={(id) =>
            setSelections((s) => ({ ...s, teacher: id }))
          }
          onSelectTimetable={setSelectedTimetableId}
          onViewChange={handleViewChange}
          selectedByClass={selections.class}
          selectedByRoom={selections.classroom}
          selectedByTeacher={selections.teacher}
          selectedTimetableId={selectedTimetableId}
          selectorLoading={selectorLoading}
          teachers={teachersQuery.data}
          timetables={timetablesQuery.data ? visibleTimetables : undefined}
          view={view}
        />

        <PrintDialog
          onGenerate={handleGeneratePdf}
          onOpenChange={setPrintDialogOpen}
          open={printDialogOpen}
        />

        {hasError && (
          <div className="text-red-500 dark:text-red-400">
            Failed to load timetable.
          </div>
        )}

        {isLoading ? (
          <div className="w-full">
            <Skeleton className="mb-2 h-8 w-64" />
            <Skeleton className="h-[130px] w-full" />
          </div>
        ) : (
          (() => {
            if (!hasError && (lessonsQuery.data ?? []).length === 0) {
              return (
                <Empty
                  description={t('timetable.emptyWeekDescription')}
                  icon={<CalendarX className="size-6" />}
                  title={t('timetable.emptyWeekTitle')}
                />
              );
            }
            return timetableContent;
          })()
        )}
      </div>
    </div>
  );
}
