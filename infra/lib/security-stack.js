/**
 * Account-level audit and threat detection.
 *
 * A third stack, and the reason is different from the landing site's. The landing
 * stack is separate because a public page must have no route to a private box.
 * This one is separate because what it creates is not *app* infrastructure at
 * all: a CloudTrail trail and a GuardDuty detector are account-wide singletons
 * whose lifetime should not be tied to the workspace they were created to watch.
 * Tearing down ClaudeWebStack must not also delete the record of what it did.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The workspace runs `claude --permission-mode bypassPermissions` and reads its
 * credentials from instance metadata, so whatever the instance role can do, a
 * prompt can do. That is a documented, accepted property of the product (see
 * docs/SECURITY.md). What is *not* acceptable is not being able to find out
 * afterwards. Without a trail, the only record of API calls made with that role
 * is CloudTrail's default 90-day Event history: not durable, not integrity
 * validated, and not exportable. The first question after any incident — "what
 * did it touch?" — has no answer.
 *
 * So: a trail that records management events account-wide, in every region,
 * writing to a private bucket with log file validation on, plus optionally the
 * service that notices unusual credential use while it is still happening.
 *
 * Neither is a control that prevents anything. They are what makes the blast
 * radius *knowable*, which is the property this repository's threat model was
 * missing.
 */
import { Stack, CfnOutput, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';

export class ClaudeWebSecurityStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const config = props.config;
    const { cloudTrail, guardDuty, logRetentionDays } = config.security;

    if (cloudTrail) {
      // --- Log bucket --------------------------------------------------------
      // The audit log is the thing an attacker with account access would most
      // like to edit, so it is configured to make that awkward: no public
      // access, TLS required, S3-managed encryption, and versioning on so an
      // overwrite leaves the previous object behind rather than replacing it.
      //
      // RETAIN on purpose, and it is the most important line in this file. A
      // `cdk destroy` that deleted the logs would destroy exactly the evidence
      // someone is destroying the stack to hide. An orphaned bucket after a
      // teardown is the correct trade.
      const trailBucket = new s3.Bucket(this, 'TrailBucket', {
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules:
          logRetentionDays > 0
            ? [
                {
                  // Expire whole objects and the versions underneath them.
                  // Without the noncurrent rule, versioning above would keep
                  // every overwritten copy forever and the retention setting
                  // would quietly mean nothing.
                  expiration: Duration.days(logRetentionDays),
                  noncurrentVersionExpiration: Duration.days(logRetentionDays),
                },
              ]
            : [],
      });

      // --- Trail -------------------------------------------------------------
      // Management events only. Data events (every S3 GET, every Lambda invoke)
      // are where CloudTrail gets expensive, and they are not what answers the
      // question this exists for: which API calls did the workspace's role make.
      //
      // `isOrganizationTrail` is deliberately not set — this is written for a
      // standalone account, which is what a personal deployment is. An account
      // inside an Organization most likely already has a trail imposed from the
      // management account, in which case set security.cloudTrail to false
      // rather than creating a second one that bills twice for the same events.
      const trail = new cloudtrail.Trail(this, 'Trail', {
        bucket: trailBucket,
        // Both of these are the point. Without multi-region, a call made in a
        // region you do not watch is invisible; without validation, the log is
        // hearsay because nothing proves it was not edited after the fact.
        isMultiRegionTrail: true,
        enableFileValidation: true,
        includeGlobalServiceEvents: true,
        managementEvents: cloudtrail.ReadWriteType.ALL,
      });

      new CfnOutput(this, 'TrailArn', {
        value: trail.trailArn,
        description: 'CloudTrail trail recording account-wide management events',
      });
      new CfnOutput(this, 'TrailBucketName', {
        value: trailBucket.bucketName,
        description: 'Bucket holding the trail logs. RETAINed on stack deletion.',
      });
    }

    if (guardDuty) {
      // AWS allows exactly one detector per account per region, and CDK has no
      // way to adopt one that already exists — so if the account has a detector
      // already, this resource fails the deploy rather than sharing it. That is
      // why the config default is false and why config.js documents it: the
      // failure is obvious and recoverable, but only if you were expecting it.
      const detector = new guardduty.CfnDetector(this, 'Detector', {
        enable: true,
        // Fifteen minutes rather than six hours. The finding this is here for is
        // credential exfiltration from the instance role, and the window between
        // "a prompt ran aws sts get-caller-identity somewhere it should not
        // have" and noticing is the entire value of the service.
        findingPublishingFrequency: 'FIFTEEN_MINUTES',
      });

      new CfnOutput(this, 'DetectorId', {
        value: detector.ref,
        description: 'GuardDuty detector watching this account',
      });
    }
  }
}
