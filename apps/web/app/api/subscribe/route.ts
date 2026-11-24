import { handleSubscribe } from '../../../src/lib/handlers';
import { getWebDeps } from '../../../src/lib/deps';
import { route } from '../../../src/lib/nextAdapter';

export const POST = route(handleSubscribe, getWebDeps());
