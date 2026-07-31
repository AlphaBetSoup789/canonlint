/**
 * Tests must be hermetic: identical results on a laptop with a full `.env`
 * loaded and on a CI runner with nothing set. Any CANONLINT_* or Anthropic
 * credential in the ambient environment would otherwise leak into config
 * resolution and change what the suite asserts.
 *
 * This also enforces the rule that no test may reach the network: with no
 * credentials present, an accidental live call fails loudly rather than
 * silently billing someone.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CANONLINT_')) delete process.env[key];
}
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;
