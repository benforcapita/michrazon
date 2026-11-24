import { unsubscribePage } from '../../src/lib/handlers';

export default function Unsubscribe({ searchParams }: { searchParams: { t?: string } }) {
  return <div dangerouslySetInnerHTML={{ __html: unsubscribePage(searchParams.t ?? '') }} />;
}
