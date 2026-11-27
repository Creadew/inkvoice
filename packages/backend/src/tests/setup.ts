// Test preload (see bunfig.toml). Most suites sign in with a password alone,
// so the authenticator requirement is off unless a suite turns it on.
process.env.MFA_REQUIRED ??= "false";
