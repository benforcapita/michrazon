import { confirmPage } from '../../src/lib/handlers';

export default async function Confirm({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  return <div dangerouslySetInnerHTML={{ __html: confirmPage(t ?? '') }} />;
}
