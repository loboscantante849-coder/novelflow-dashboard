const has = (name) => Boolean(String(process.env[name] || '').trim());
const oneOf = (names) => names.some(has);

const required = [
  ['Discord signature verification', () => has('DISCORD_PUBLIC_KEY')],
  ['Discord access control', () => oneOf(['NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS', 'NOVELFLOW_DISCORD_ALLOWED_ROLE_IDS'])],
  ['Discord attribution channel', () => has('NOVELFLOW_DISCORD_CHANNEL_NAME_ID')],
  ['Discord attribution promoter', () => has('NOVELFLOW_DISCORD_PROMOTER')],
  ['Discord screenshot OCR model', () => has('NOVELFLOW_OCR_MODEL')],
  ['Discord screenshot OCR credential', () => oneOf(['NOVELFLOW_OCR_API_KEY', 'NOVELFLOW_COPY_LLM_API_KEY', 'NOVELFLOW_LLM_API_KEY'])],
  ['Social Redis storage', () => (has('KV_REST_API_URL') && has('KV_REST_API_TOKEN')) || (has('SOCIAL_STORE_URL') && has('SOCIAL_STORE_SECRET'))],
  ['NovelFlow bookstore authentication', () => has('NOVELFLOW_OIDC_TOKEN') || (has('NOVELFLOW_OIDC_USERNAME') && has('NOVELFLOW_OIDC_PASSWORD'))]
];
const optional = [
  ['DeepSeek candidate rerank', ['NOVELFLOW_COPY_LLM_API_KEY', 'NOVELFLOW_LLM_API_KEY']],
  ['Operator audit endpoint', ['NOVELFLOW_DISCORD_OPERATOR_TOKEN']]
];

let missing = 0;
for (const [label, check] of required) {
  const ready = check();
  process.stdout.write(`${ready ? 'OK' : 'MISSING'}  ${label}\n`);
  if (!ready) missing += 1;
}
for (const [label, names] of optional) process.stdout.write(`${oneOf(names) ? 'OK' : 'OPTIONAL'}  ${label}\n`);
if (missing) {
  process.stderr.write(`Discord deployment is not ready: ${missing} required configuration group(s) missing.\n`);
  process.exitCode = 1;
} else process.stdout.write('Discord deployment configuration is ready.\n');
