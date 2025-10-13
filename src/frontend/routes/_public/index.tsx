import { createFileRoute } from '@tanstack/react-router';
import { TimetableView } from '~/frontend/components/timetable-view';

export const Route = createFileRoute('/_public/')({
  component: App,
});

function App() {
  return <TimetableView />;
}
