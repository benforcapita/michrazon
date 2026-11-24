#!/usr/bin/env node
// Creates the PRO-812 worker env placeholders on Railway:
//   project "michrazon" -> service "worker" -> environment "production"
//
// Non-secret keys get their pilot values; secret keys are created EMPTY so
// Ben can paste values in the dashboard. Never pass real secrets to this
// script — it only ever writes the values listed in VARS below.
//
// Usage:
//   RAILWAY_TOKEN=<token> node scripts/railway/create-worker-env-stubs.mjs
//   node scripts/railway/create-worker-env-stubs.mjs --dry-run   # print plan only
//
// Token: Railway account/team token with access to the project (Railway ->
// Account Settings -> Tokens). If the token is a project-scoped token the
// name lookups may fail — in that case pass IDs directly:
//   RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT_ID=… RAILWAY_SERVICE_ID=…

const API = 'https://backboard.railway.com/graphql/v2';

const PROJECT_NAME = process.env.RAILWAY_PROJECT_NAME ?? 'michrazon';
const SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME ?? 'worker';
const ENVIRONMENT_NAME = process.env.RAILWAY_ENVIRONMENT_NAME ?? 'production';
const DRY_RUN = process.argv.includes('--dry-run');

const VARS = [
  ['LLM_PROVIDER', 'jev'],
  ['TYPESAFE_API_KEY', ''], // secret — Ben pastes the value
  ['TYPESAFE_MODEL', ''], // optional; unset = service default model
  ['JEV_MIN_CONFIDENCE', '0.55'],
  ['SUMMARIES_ENABLED', 'false'],
];

const token = process.env.RAILWAY_TOKEN;

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`railway api: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

const byName = (edges, name, kind) => {
  const hit = edges.find((e) => e.node.name === name)?.node;
  if (!hit) throw new Error(`${kind} '${name}' not found (pass an explicit *_ID env var)`);
  return hit.id;
};

async function resolveIds() {
  if (
    process.env.RAILWAY_PROJECT_ID &&
    process.env.RAILWAY_ENVIRONMENT_ID &&
    process.env.RAILWAY_SERVICE_ID
  ) {
    return {
      projectId: process.env.RAILWAY_PROJECT_ID,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
      serviceId: process.env.RAILWAY_SERVICE_ID,
    };
  }
  const projects = await gql(`{ projects { edges { node { id name } } } }`);
  const projectId = byName(projects.projects.edges, PROJECT_NAME, 'project');
  const data = await gql(
    `query($id: String!) {
       project(id: $id) {
         environments { edges { node { id name } } }
         services { edges { node { id name } } }
       }
     }`,
    { id: projectId },
  );
  return {
    projectId,
    environmentId: byName(data.project.environments.edges, ENVIRONMENT_NAME, 'environment'),
    serviceId: byName(data.project.services.edges, SERVICE_NAME, 'service'),
  };
}

async function upsert(ids, name, value) {
  await gql(
    `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
    { input: { ...ids, name, value } },
  );
}

console.log(`railway env stubs — ${PROJECT_NAME}/${SERVICE_NAME}/${ENVIRONMENT_NAME}`);
for (const [name, value] of VARS) {
  console.log(`  ${name}=${value === '' ? '(empty)' : value}`);
}
if (DRY_RUN) {
  console.log('dry run — no changes made');
  process.exit(0);
}
if (!token) {
  console.error('RAILWAY_TOKEN is required (or pass --dry-run)');
  process.exit(1);
}

const ids = await resolveIds();
console.log(`resolved project=${ids.projectId} env=${ids.environmentId} service=${ids.serviceId}`);
for (const [name, value] of VARS) {
  await upsert(ids, name, value);
  console.log(`upserted ${name}`);
}
console.log('done — paste secret values in the Railway dashboard (worker -> Variables)');
