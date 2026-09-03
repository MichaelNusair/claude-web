#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ClaudeWebStack } from '../lib/stack.js';
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
