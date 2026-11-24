import { prefsPage } from '../../src/lib/handlers';

export default async function Prefs({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  return <div dangerouslySetInnerHTML={{ __html: prefsPage(t ?? '', []) }} />;
}
