import { Stack, Duration, CfnOutput, RemovalPolicy, Tags, Size } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// code-server listens here; only the ALB can reach it.
const APP_PORT = 8080;
// The VPC's address range, passed to nginx so it can trust X-Forwarded-For from
// the load balancer and recover the real client IP for login throttling.
const VPC_CIDR = '10.0.0.0/16';

export class ClaudeWebStack extends Stack {
  /**
   * @param {object} props.config Result of loadConfig() — see infra/config.js.
   *   Nothing about a particular AWS account is hardcoded in this file.
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    const config = props.config;
    const DOMAIN_NAME = config.domainName;

    // Single AZ: the workspace is one instance with one persistent EBS volume,
    // and EBS volumes cannot cross AZs.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const workspaceAz = vpc.availabilityZones[0];

    // --- Secrets -------------------------------------------------------------
    // The login password, shared by the chat's own gate and code-server.
    // Generated once and kept across deploys so the URL stays bookmarkable.
    const passwordSecret = new secretsmanager.Secret(this, 'CodeServerPassword', {
      description: `Login password for ${DOMAIN_NAME}`,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    // Signs the chat's session cookies. Separate from the password so that
    // rotating one does not force the other, and generated rather than derived
    // so a guessed password still cannot be turned into a forged session.
    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: `Session cookie signing key for ${DOMAIN_NAME}`,
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      // Losing this only signs everyone out; keeping it avoids that on a
      // rebuild, which is the common case.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Azure Whisper credentials for voice dictation. Created empty; populate
    // with `aws secretsmanager put-secret-value` (see README).
    const whisperSecret = new secretsmanager.Secret(this, 'WhisperConfig', {
      description: 'Azure OpenAI Whisper endpoint + key for voice dictation',
      secretObjectValue: {},
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // GitHub token so Claude can clone, pull, push and open PRs the way it does
    // locally. Kept in Secrets Manager and fetched by a git credential helper at
    // request time, rather than written into ~/.git-credentials on disk.
    const githubSecret = new secretsmanager.Secret(this, 'GithubToken', {
      description: 'GitHub PAT for git operations from the workspace',
      secretObjectValue: {},
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Transfer bucket ----------------------------------------------------
    // Staging area for payloads too large for SSM's inline parameter limit
    // (session-history migration). Contents are transient.
    const transferBucket = new s3.Bucket(this, 'TransferBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(2) }],
    });

    // --- Persistent workspace volume ----------------------------------------
    // Standalone volume (not a block device on the instance) so that replacing
    // the instance never destroys projects or Claude Code session history.
    const dataVolume = new ec2.Volume(this, 'WorkspaceVolume', {
      availabilityZone: workspaceAz,
      size: Size.gibibytes(config.workspaceVolumeSize),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(dataVolume).add('Name', 'claude-workspace-data');

    // --- Security groups -----------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, 'AlbSG', { vpc, allowAllOutbound: true });
    // Defaults to the whole internet, which is what the login gate is for. An
    // allowlist in config.allowedCidrs narrows it to known networks, which is
    // worth doing whenever the deployment does not need to be publicly reachable.
    for (const cidr of config.allowedCidrs) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `HTTP from ${cidr}`);
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `HTTPS from ${cidr}`);
    }

    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSG', { vpc, allowAllOutbound: true });
    instanceSg.addIngressRule(albSg, ec2.Port.tcp(APP_PORT), 'code-server, from ALB only');
    // No SSH ingress: shell access is via SSM Session Manager, which needs no
    // open port and is audited.

    // --- Instance role -------------------------------------------------------
    // Least privilege by default. The explicit grants below (Bedrock invoke, its
    // own secrets, its own volume, its own bucket) are everything the product
    // needs to run.
    //
    // `instanceAdminAccess: true` adds AdministratorAccess, which buys parity
    // with a developer laptop — CDK deploys, S3, Lambda — at a real cost:
    // anything running in the workspace reaches the whole account through
    // instance metadata, and Claude runs here with permission to execute
    // commands. That combination turns one leaked password into account
    // takeover, so it is opt-in rather than the default a new deployer inherits.
    const managedPolicies = [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    ];
    if (config.instanceAdminAccess) {
      managedPolicies.push(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
    }

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies,
    });

    // Bedrock: model invocation only, not account-wide Bedrock admin.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListInferenceProfiles', 'bedrock:ListFoundationModels'],
        resources: ['*'],
      }),
    );
    passwordSecret.grantRead(role);
    sessionSecret.grantRead(role);
    whisperSecret.grantRead(role);
    githubSecret.grantRead(role);
    transferBucket.grantRead(role);
    // Needed so userdata can wait for and mount its own data volume.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeVolumes'],
        resources: ['*'],
      }),
    );

    // --- Provisioning script -------------------------------------------------
    // EC2 caps userdata at 25,600 bytes *base64-encoded*, which the bootstrap
    // script outgrew. Ship it as an S3 asset and have userdata fetch it, so the
    // script can grow freely and edits still trigger an instance replacement
    // (the asset hash is part of the userdata).
    const bootstrapAsset = new s3_assets.Asset(this, 'BootstrapScript', {
      path: join(__dirname, '..', 'userdata', 'bootstrap.sh'),
    });
    bootstrapAsset.grantRead(role);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'export HOME=/root',
      `aws s3 cp s3://${bootstrapAsset.s3BucketName}/${bootstrapAsset.s3ObjectKey} /tmp/bootstrap.sh --region ${this.region}`,
      'chmod +x /tmp/bootstrap.sh',
      // Placeholders are substituted here rather than baked into the asset, so
      // the asset stays stable when only an ARN or volume id changes.
      `sed -i \\
        -e 's|__APP_PORT__|${APP_PORT}|g' \\
        -e 's|__REGION__|${this.region}|g' \\
        -e 's|__PASSWORD_SECRET_ARN__|${passwordSecret.secretArn}|g' \\
        -e 's|__SESSION_SECRET_ARN__|${sessionSecret.secretArn}|g' \\
        -e 's|__WHISPER_SECRET_ARN__|${whisperSecret.secretArn}|g' \\
        -e 's|__GITHUB_SECRET_ARN__|${githubSecret.secretArn}|g' \\
        -e 's|__DATA_VOLUME_ID__|${dataVolume.volumeId}|g' \\
        -e 's|__DOMAIN_NAME__|${DOMAIN_NAME}|g' \\
        -e 's|__VPC_CIDR__|${VPC_CIDR}|g' \\
        -e 's|__AUTH_MODE__|${config.authMode}|g' \\
        -e 's|__OIDC_CLIENT_ID__|${config.oidc.clientId}|g' \\
        -e 's|__GIT_USER_NAME__|${config.gitUserName}|g' \\
        -e 's|__GIT_USER_EMAIL__|${config.gitUserEmail}|g' \\
        -e 's|__DEFAULT_MODEL__|${config.defaultModel}|g' \\
        -e 's|__PERMISSION_MODE__|${config.permissionMode}|g' \\
        -e 's|__EFFORT_LEVEL__|${config.effortLevel}|g' \\
        /tmp/bootstrap.sh`,
      // Keep a persistent copy (with placeholders already substituted) so
      // deploy.sh can re-run provisioning on the live instance without a
      // rebuild, and so it survives reboots.
      'install -m 0755 /tmp/bootstrap.sh /opt/bootstrap.sh',
      'bash /opt/bootstrap.sh',
    );

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      // Graviton: the Claude Code extension ships a verified linux-arm64 build,
      // and ARM is ~20% cheaper than the equivalent x86 instance.
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: instanceSg,
      role,
      userData,
      // Deliberately false: it stops CDK from folding the userdata hash into the
      // instance's *logical id*, which made every bootstrap edit a guaranteed
      // rebuild — and each rebuild dropped the app payload until the next deploy
      // re-pushed it. Provisioning changes are applied to the running box by
      // deploy.sh instead.
      //
      // It does not make userdata edits free. CloudFormation's own update
      // behaviour for `UserData` on a running instance is replacement, so a
      // changed bootstrap asset hash still replaces the box: observed
      // 2026-09-15, i-00a02e3307d3b8799 → i-0533875a166194308. Check `cdk diff`
      // for "may be replaced" before assuming otherwise, and drive that deploy
      // from somewhere other than the instance being replaced — /opt/claude-web
      // is on the root volume, and the payload that recreates it is pushed after
      // the stack completes.
      userDataCausesReplacement: false,
      vpcSubnets: { availabilityZones: [workspaceAz], subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(config.rootVolumeSize, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // The instance attaches the volume itself in userdata rather than via a
    // CfnVolumeAttachment. CloudFormation creates the replacement attachment
    // before deleting the old one, and a volume can only be attached to one
    // instance — so a CFN-managed attachment makes instance replacement fail
    // with "already attached". Self-attach also avoids the circular dependency
    // that grantAttachVolume(role, [instance]) would introduce.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:AttachVolume', 'ec2:DetachVolume'],
        resources: [
          `arn:aws:ec2:${this.region}:${this.account}:volume/${dataVolume.volumeId}`,
          `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
        ],
      }),
    );

    // --- Load balancer -------------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      // code-server holds a WebSocket open for the life of the editor session.
      // The 60s default would tear the UI down every minute.
      idleTimeout: Duration.seconds(4000),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port: APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2_targets.InstanceTarget(instance, APP_PORT)],
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        // First boot installs code-server, Node and the extension.
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: Duration.seconds(10),
    });

    // --- DNS + certificate ---------------------------------------------------
    // The zone must already exist; the record and the certificate are created
    // here. An explicit hostedZoneId avoids a lookup (and avoids caching the
    // account id into cdk.context.json), otherwise the zone is resolved by name.
    const zone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: config.hostedZoneId,
          zoneName: config.hostedZoneName,
        })
      : route53.HostedZone.fromLookup(this, 'Zone', { domainName: config.hostedZoneName });

    // Issue a DNS-validated certificate unless an existing one was supplied.
    // Creating it here is what lets someone deploy this into their own account
    // without first provisioning a certificate by hand.
    const certificate = config.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', config.certificateArn)
      : new acm.Certificate(this, 'Cert', {
          domainName: DOMAIN_NAME,
          validation: acm.CertificateValidation.fromDns(zone),
        });

    const httpsListener = alb.addListener('HTTPS', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      // In OIDC mode the default action is the login flow, added below, so no
      // request reaches the instance before the provider has authenticated it.
      defaultTargetGroups: config.authMode === 'oidc' ? undefined : [targetGroup],
      defaultAction:
        config.authMode === 'oidc'
          ? elbv2.ListenerAction.authenticateOidc({
              issuer: config.oidc.issuer,
              authorizationEndpoint: config.oidc.authorizationEndpoint,
              tokenEndpoint: config.oidc.tokenEndpoint,
              userInfoEndpoint: config.oidc.userInfoEndpoint,
              clientId: config.oidc.clientId,
              clientSecret: secretsmanager.Secret.fromSecretCompleteArn(
                this,
                'OidcClientSecret',
                config.oidc.clientSecretArn,
              ).secretValue,
              next: elbv2.ListenerAction.forward([targetGroup]),
            })
          : undefined,
    });

    // The health check must stay reachable without authentication or the ALB
    // marks its own target unhealthy and serves 503 to everyone.
    if (config.authMode === 'oidc') {
      httpsListener.addAction('HealthCheckBypass', {
        priority: 1,
        conditions: [elbv2.ListenerCondition.pathPatterns(['/healthz'])],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    alb.addListener('HTTP', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: DOMAIN_NAME,
      target: route53.RecordTarget.fromAlias(new route53_targets.LoadBalancerTarget(alb)),
    });

    // --- Outputs -------------------------------------------------------------
    // `--profile` is included only when the deployment configured one, so these
    // commands are copy-pasteable for someone using the default credential chain.
    const profileFlag = config.awsProfile ? ` --profile ${config.awsProfile}` : '';

    new CfnOutput(this, 'AppURL', { value: `https://${DOMAIN_NAME}` });
    new CfnOutput(this, 'EditorURL', { value: `https://${DOMAIN_NAME}/editor/` });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'PasswordCommand', {
      value: `aws secretsmanager get-secret-value --secret-id ${passwordSecret.secretArn} --query SecretString --output text${profileFlag} --region ${this.region}`,
      description: 'Run this to print the login password',
    });
    new CfnOutput(this, 'SessionSecretArn', {
      value: sessionSecret.secretArn,
      description: 'Signs session cookies. Rotate to sign every device out.',
    });
    new CfnOutput(this, 'GithubSecretArn', {
      value: githubSecret.secretArn,
      description: 'Put a GitHub PAT here: {"token":"ghp_..."}',
    });
    new CfnOutput(this, 'WhisperSecretArn', {
      value: whisperSecret.secretArn,
      description: 'Put Azure Whisper endpoint/key here to enable voice dictation',
    });
    new CfnOutput(this, 'TransferBucketName', {
      value: transferBucket.bucketName,
      description: 'Staging bucket used by migrate.sh for large transfers',
    });
    new CfnOutput(this, 'ShellCommand', {
      value: `aws ssm start-session --target ${instance.instanceId}${profileFlag} --region ${this.region}`,
    });
  }
}
