/**
 * Strip ambient model-routing configuration so tests are hermetic against the
 * environment that launched them. When the tests run inside a Pi orchestrator,
 * PI_OPENCODE_PROFILE_TESTER / PI_OPENCODE_PROFILE_REVIEWER can be exported as
 * `pi::...` values; without this cleanup, role/profile-based test specs resolve
 * to the Pi backend and spawn the real Pi CLI instead of the fake worker
 * binary, failing with a crashed child (exit 0xC0000409) and `error` status.
 * Each test file runs in its own process, so this module-scope cleanup stays
 * process-local; tests that exercise env-based configuration set their own
 * values explicitly and save/restore around themselves.
 */
export function clearAmbientModelConfigEnv(env: NodeJS.ProcessEnv = process.env): void {
	delete env.PI_OPENCODE_MODEL;
	delete env.PI_OPENCODE_PROFILE_IMPLEMENTER;
	delete env.PI_OPENCODE_PROFILE_REVIEWER;
	delete env.PI_OPENCODE_PROFILE_TESTER;
}
