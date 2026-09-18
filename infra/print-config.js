#!/usr/bin/env node
/**
 * Print the validated configuration as shell assignments, for `eval` in
 * deploy.sh and migrate.sh.
 *
 * Exists so the shell scripts never parse claude-web.config.json themselves.
 * Two parsers for one file drift, and the one in a shell script would skip the
 * validation in config.js — which is where the useful error messages live.
 *
 * On invalid config it prints a shell snippet that reports the error and exits
 * non-zero, so `eval "$(node infra/print-config.js)"` fails loudly.
 */
import { loadConfig } from './config.js';

/** Single-quote for the shell, escaping embedded single quotes safely. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stdout.write(`printf '%s\\n' ${shellQuote(err.message)} >&2\nexit 1\n`);
  process.exit(0);
}

const exported = {
  CFG_DOMAIN: config.domainName,
  CFG_REGION: config.region,
  CFG_PROFILE: config.awsProfile,
  CFG_STACK: config.stackName,
  CFG_AUTH_MODE: config.authMode,
  CFG_PERMISSION_MODE: config.permissionMode,
  CFG_ADMIN: config.instanceAdminAccess,
  CFG_INSTANCE_TYPE: config.instanceType,
  CFG_LANDING_DOMAIN: config.landing.domainName,
  CFG_LANDING_STACK: config.landing.stackName,
  CFG_SECURITY_ENABLED: config.security.enabled,
  CFG_SECURITY_STACK: config.security.stackName,
  CFG_SECURITY_CLOUDTRAIL: config.security.cloudTrail,
  CFG_SECURITY_GUARDDUTY: config.security.guardDuty,
  CFG_DEPLOY_INSTANCE: config.deployFrom.instanceId,
  CFG_DEPLOY_PATH: config.deployFrom.repoPath,
  CFG_DEPLOY_USER: config.deployFrom.user,
};

for (const [key, value] of Object.entries(exported)) {
  process.stdout.write(`${key}=${shellQuote(value)}\n`);
}
