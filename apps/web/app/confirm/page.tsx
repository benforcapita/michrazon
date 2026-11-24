import { confirmPage } from '../../src/lib/handlers';

export default function Confirm({ searchParams }: { searchParams: { t?: string } }) {
  return <div dangerouslySetInnerHTML={{ __html: confirmPage(searchParams.t ?? '') }} />;
}
