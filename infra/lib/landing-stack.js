/**
 * The marketing site: a static page on S3, served by CloudFront.
 *
 * Deliberately a separate stack from the workspace, with no shared resources.
 * The workspace is a machine that runs shell commands; this is a public web
 * page. Keeping them apart means the public thing has no route to the private
 * thing, and that deploying or breaking one cannot affect the other.
 *
 * Always synthesized into us-east-1: CloudFront only reads ACM certificates
 * from that region, whatever region the rest of the deployment uses.
 *
 * Content is uploaded by deploy-landing.sh with `aws s3 sync` rather than a
 * BucketDeployment construct — the files are a handful of static assets, and a
 * plain sync is easier to reason about and to debug than a custom resource.
 */
import { Stack, CfnOutput, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';

export class ClaudeWebLandingStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const config = props.config;
    const domainName = config.landing.domainName;

    // --- Bucket --------------------------------------------------------------
    // Private, with no public access and no website hosting. CloudFront reaches
    // it through Origin Access Control, so the bucket is never addressable
    // directly and there is no second, unprotected way to serve the site.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // A marketing page is disposable and reproducible from the repo, so a
      // teardown should not leave an orphaned bucket behind.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Certificate ---------------------------------------------------------
    const zone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: config.hostedZoneId,
          zoneName: config.hostedZoneName,
        })
      : route53.HostedZone.fromLookup(this, 'Zone', { domainName: config.hostedZoneName });

    // Reuse an existing certificate when given one — a wildcard covering the
    // zone already covers this hostname, so most deployments need nothing new.
    const certificate = config.landing.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', config.landing.certificateArn)
      : new acm.Certificate(this, 'Cert', {
          domainName,
          validation: acm.CertificateValidation.fromDns(zone),
        });

    // --- Security headers ----------------------------------------------------
    // A static page with no login and no user data, so these are cheap
    // hardening rather than load-bearing. The CSP is strict because the page
    // genuinely needs nothing external: no analytics, no fonts, no CDN scripts.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'none'",
            "img-src 'self' data:",
            "style-src 'self'",
            "script-src 'self'",
            "font-src 'self'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    // --- Distribution --------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: headers,
      },
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // North America + Europe. The cheapest class; a marketing page does not
      // need edge locations everywhere.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      errorResponses: [
        // A single-page site: anything missing shows the page rather than an
        // XML S3 error, and 404 is preserved so it is honest to crawlers.
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.minutes(5) },
      ],
    });

    // --- DNS -----------------------------------------------------------------
    // Both records, so the site resolves for IPv6-only clients too.
    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, 'AliasRecordV6', {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.CloudFrontTarget(distribution),
      ),
    });

    // --- Outputs -------------------------------------------------------------
    new CfnOutput(this, 'LandingURL', { value: `https://${domainName}` });
    new CfnOutput(this, 'SiteBucketName', {
      value: bucket.bucketName,
      description: 'deploy-landing.sh syncs the landing/ directory here',
    });
    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'Used to invalidate the cache after a content sync',
    });
  }
}
