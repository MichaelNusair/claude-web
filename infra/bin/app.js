#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ClaudeWebStack } from '../lib/stack.js';
import { ClaudeWebLandingStack } from '../lib/landing-stack.js';
import { loadConfig } from '../config.js';

// Configuration is validated before the app is constructed, so a missing domain
// or a malformed CIDR is reported as a one-line message naming the setting
// rather than as a CloudFormation failure halfway through a deploy.
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

const app = new App();

new ClaudeWebStack(app, config.stackName, {
  config,
  env: {
    // Account comes from the ambient credentials; only the region is pinned, so
    // nothing here is specific to one AWS account.
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
  description: `Claude Code as a self-hosted web app at ${config.domainName}`,
});

// The marketing site is opt-in and fully independent: a separate stack, its own
// hostname, no shared resources with the workspace. `cdk deploy` targets one
// stack by name, so adding this never changes what a workspace deploy touches.
if (config.landing.domainName) {
  new ClaudeWebLandingStack(app, config.landing.stackName, {
    config,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      // Pinned: CloudFront reads certificates only from us-east-1.
      region: 'us-east-1',
    },
    description: `Landing page for claude-web at ${config.landing.domainName}`,
    crossRegionReferences: true,
  });
}
