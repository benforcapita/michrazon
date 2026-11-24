import { unsubscribePage } from '../../src/lib/handlers';

export default async function Unsubscribe({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  return <div dangerouslySetInnerHTML={{ __html: unsubscribePage(t ?? '') }} />;
}
