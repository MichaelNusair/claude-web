/**
 * Deployment configuration.
 *
 * Everything that used to be a constant in stack.js — domain, hosted zone,
 * certificate ARN, AWS profile, git identity — lives here and comes from a
 * config file or the environment. The stack no longer contains anyone's account
 * id, so the repository can be published and deployed by anyone.
 *
 * Precedence: environment variable > claude-web.config.json > default.
 * Environment wins so CI can override a single value without editing a file.
 *
 * Validation is deliberately loud and specific. Someone deploying this for the
 * first time is one typo away from a CloudFormation error that names a resource
 * rather than the setting that was wrong, and an AI agent helping them needs the
 * message to say what to fix.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * Resolved per call rather than once at import, so the path is read from the
 * environment as it is when the config is actually loaded — which is what makes
 * this testable and lets a caller point at an alternate file.
 */
function configPath() {
  return process.env.CLAUDE_WEB_CONFIG || join(REPO_ROOT, 'claude-web.config.json');
}

const DEFAULTS = {
  // --- Required ------------------------------------------------------------
  /** Fully-qualified hostname the app is served at, e.g. "claude.example.com". */
  domainName: '',
  /** The Route53 zone that hostname belongs to, e.g. "example.com". */
  hostedZoneName: '',

  // --- Optional ------------------------------------------------------------
  /** Zone id. Looked up from hostedZoneName when omitted. */
  hostedZoneId: '',
  /** Existing certificate to reuse. A DNS-validated one is created when empty. */
  certificateArn: '',
  region: 'us-east-1',
  stackName: 'ClaudeWebStack',
  /** Named AWS profile for the CLI/CDK. Empty uses the default credential chain. */
  awsProfile: '',

  /** "password" (self-contained) or "oidc" (authenticate at the load balancer). */
  authMode: 'password',
  oidc: {
    issuer: '',
    authorizationEndpoint: '',
    tokenEndpoint: '',
    userInfoEndpoint: '',
    clientId: '',
    /** Read from Secrets Manager at deploy time; never commit the value. */
    clientSecretArn: '',
  },

  /**
   * Restrict who can reach the load balancer at all. Defaulting to the whole
   * internet is what the password protects, but an allowlist is strictly better
   * when the deployment only ever needs to serve a known network.
   */
  allowedCidrs: ['0.0.0.0/0'],

  instanceType: 't4g.large',
  /** GiB. Holds every cloned repo plus all Claude Code session history. */
  workspaceVolumeSize: 100,
  rootVolumeSize: 40,

  /**
   * Attach AdministratorAccess to the instance role.
   *
   * Off by default, and that default is a security decision rather than a
   * preference: Claude runs on this box with permission to execute commands, so
   * whatever the role can do, a prompt can do. The narrow grants the stack adds
   * (Bedrock invoke, its own secrets, its own volume) are enough to run the
   * product. Turn this on only if you want the workspace to deploy other AWS
   * infrastructure, and understand that it makes the login password the only
   * thing standing between the internet and your whole account.
   */
  instanceAdminAccess: false,

  defaultModel: 'us.anthropic.claude-opus-5',
  /** "bypassPermissions" | "acceptEdits" | "plan". See docs/SECURITY.md. */
  permissionMode: 'bypassPermissions',
  effortLevel: 'xhigh',

  gitUserName: 'Claude Web',
  gitUserEmail: 'claude-web@example.invalid',
};

/** Environment overrides, flattened. */
const ENV_MAP = {
  CLAUDE_WEB_DOMAIN: 'domainName',
  CLAUDE_WEB_HOSTED_ZONE: 'hostedZoneName',
  CLAUDE_WEB_HOSTED_ZONE_ID: 'hostedZoneId',
  CLAUDE_WEB_CERT_ARN: 'certificateArn',
  CLAUDE_WEB_REGION: 'region',
  CLAUDE_WEB_STACK_NAME: 'stackName',
  AWS_PROFILE: 'awsProfile',
  CLAUDE_WEB_AUTH_MODE: 'authMode',
  CLAUDE_WEB_INSTANCE_TYPE: 'instanceType',
  CLAUDE_WEB_DEFAULT_MODEL: 'defaultModel',
  CLAUDE_WEB_PERMISSION_MODE: 'permissionMode',
  CLAUDE_WEB_GIT_USER_NAME: 'gitUserName',
  CLAUDE_WEB_GIT_USER_EMAIL: 'gitUserEmail',
};

const VALID_AUTH_MODES = ['password', 'oidc'];
const VALID_PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan', 'default'];

function fail(message) {
  throw new Error(`Invalid configuration: ${message}`);
}

export function loadConfig() {
  const file = configPath();
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`${file} is not valid JSON — ${err.message}`);
    }
    // JSON has no comments, so the example file documents itself with "$comment"
    // keys. Drop them rather than carrying them into the config object.
    fromFile = Object.fromEntries(
      Object.entries(fromFile).filter(([key]) => !key.startsWith('$')),
    );
  }

  const config = {
    ...DEFAULTS,
    ...fromFile,
    oidc: { ...DEFAULTS.oidc, ...(fromFile.oidc || {}) },
  };

  for (const [envVar, key] of Object.entries(ENV_MAP)) {
    if (process.env[envVar]) config[key] = process.env[envVar];
  }

  // Booleans and numbers survive a round trip through the environment.
  if (process.env.CLAUDE_WEB_ADMIN_ACCESS) {
    config.instanceAdminAccess = process.env.CLAUDE_WEB_ADMIN_ACCESS === 'true';
  }

  // --- Validation ----------------------------------------------------------
  if (!config.domainName) {
    fail(
      'domainName is required. Set it in claude-web.config.json (copy ' +
        'claude-web.config.example.json) or pass CLAUDE_WEB_DOMAIN. This is the ' +
        'hostname you will open in a browser, e.g. "claude.example.com".',
    );
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(config.domainName)) {
    fail(`domainName "${config.domainName}" is not a hostname. Expected e.g. "claude.example.com".`);
  }
  if (!config.hostedZoneName) {
    fail(
      'hostedZoneName is required — the Route53 hosted zone that contains ' +
        `"${config.domainName}", e.g. "example.com". The deployment creates a DNS ` +
        'record and validates a TLS certificate in this zone, so it must already exist.',
    );
  }
  if (!config.domainName.endsWith(config.hostedZoneName)) {
    fail(
      `domainName "${config.domainName}" is not inside hostedZoneName ` +
        `"${config.hostedZoneName}". DNS validation and the alias record would both fail.`,
    );
  }

  if (!VALID_AUTH_MODES.includes(config.authMode)) {
    fail(`authMode "${config.authMode}" is not one of: ${VALID_AUTH_MODES.join(', ')}.`);
  }
  if (config.authMode === 'oidc') {
    const missing = ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'userInfoEndpoint',
      'clientId', 'clientSecretArn'].filter((k) => !config.oidc[k]);
    if (missing.length) {
      fail(
        `authMode is "oidc" but these oidc settings are missing: ${missing.join(', ')}. ` +
          'See docs/DEPLOY.md for where to find them for Google, GitHub or Cognito. ' +
          'Leave authMode as "password" if you do not want to configure a provider.',
      );
    }
  }

  if (!VALID_PERMISSION_MODES.includes(config.permissionMode)) {
    fail(
      `permissionMode "${config.permissionMode}" is not one of: ` +
        `${VALID_PERMISSION_MODES.join(', ')}.`,
    );
  }

  if (!Array.isArray(config.allowedCidrs) || config.allowedCidrs.length === 0) {
    fail('allowedCidrs must be a non-empty array, e.g. ["0.0.0.0/0"] or ["203.0.113.4/32"].');
  }
  for (const cidr of config.allowedCidrs) {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) {
      fail(`allowedCidrs entry "${cidr}" is not an IPv4 CIDR block, e.g. "203.0.113.0/24".`);
    }
  }

  for (const [key, value] of Object.entries({
    workspaceVolumeSize: config.workspaceVolumeSize,
    rootVolumeSize: config.rootVolumeSize,
  })) {
    if (!Number.isInteger(value) || value < 8) {
      fail(`${key} must be a whole number of GiB, at least 8. Got ${JSON.stringify(value)}.`);
    }
  }

  if (config.gitUserEmail === DEFAULTS.gitUserEmail) {
    // Not fatal: commits still work, they just carry a placeholder author.
    console.warn(
      '[config] gitUserEmail is unset, so commits Claude makes on the workspace ' +
        `will be authored as <${DEFAULTS.gitUserEmail}>. Set gitUserName and ` +
        'gitUserEmail to your own.',
    );
  }

  return config;
}
