import { landingPage } from '../src/lib/handlers';

export default function Home() {
  return <div dangerouslySetInnerHTML={{ __html: landingPage() }} />;
}
