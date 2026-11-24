import { prefsPage } from '../../src/lib/handlers';

export default function Prefs({ searchParams }: { searchParams: { t?: string } }) {
  return <div dangerouslySetInnerHTML={{ __html: prefsPage(searchParams.t ?? '', []) }} />;
}
