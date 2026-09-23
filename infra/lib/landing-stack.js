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
import {
  PROXY_PATH,
  analyticsEnabled,
  landingCsp,
  posthogOrigins,
} from '../landing-analytics.js';

export class TripleCLandingStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const config = props.config;
    const domainName = config.landing.domainName;

    /*
     * The zone this site's hostname belongs to, which is not necessarily the
     * workspace's. A product's marketing domain is usually a domain, not a
     * subdomain of the box: `triplec.host`, not `www.the-zone-the-instance-is-in`.
     * config.js validates that domainName is inside whichever of the two this
     * resolves to, so the check and the record below read the same value.
     */
    const zoneName = config.landing.hostedZoneName || config.hostedZoneName;
    const zoneId = config.landing.hostedZoneName
      ? config.landing.hostedZoneId
      : config.hostedZoneId;

    // Analytics is opt-in per deployment. With no key configured this stack is
    // exactly what it was before: one origin, one behaviour, and a CSP that
    // permits nothing external.
    const analytics = analyticsEnabled(config.landing)
      ? posthogOrigins(config.landing.analytics.region)
      : null;

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
    const zone = zoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: zoneId,
          zoneName: zoneName,
        })
      : route53.HostedZone.fromLookup(this, 'Zone', { domainName: zoneName });

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
    // hardening rather than load-bearing. The policy itself is built in
    // infra/landing-analytics.js, which is also where the page's analytics path
    // is defined — the two cannot be allowed to disagree, and a CSP that forbids
    // what the page does shows up as a perfect-looking page recording nothing.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: landingCsp({ analytics: Boolean(analytics) }),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        // X-Frame-Options has only DENY and SAMEORIGIN, no allowlist, so it is
        // dropped when analytics is on: it would otherwise override the CSP's
        // narrower permission for PostHog's heatmap view to frame the page.
        ...(analytics
          ? {}
          : {
              frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            }),
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    // --- Analytics proxy -----------------------------------------------------
    // PostHog, forwarded from PROXY_PATH on this distribution so that everything
    // the page does is first-party: the SDK, the events, the replay snapshots.
    // Requests to posthog.com are on every blocker list, and a blocked request is
    // an invisible visit rather than a degraded one.
    const proxyBehaviors = {};
    if (analytics) {
      // PostHog knows nothing about PROXY_PATH, so it comes off at the edge.
      // A viewer-request function runs *after* the path pattern has selected the
      // behaviour, which is what lets the behaviours below match on the prefix and
      // the origin still see the path it expects.
      const stripPrefix = new cloudfront.Function(this, 'StripAnalyticsPrefix', {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        comment: `Remove ${PROXY_PATH} before forwarding to PostHog`,
        code: cloudfront.FunctionCode.fromInline(
          [
            'function handler(event) {',
            '  var request = event.request;',
            `  request.uri = request.uri.substring(${PROXY_PATH.length}) || '/';`,
            '  return request;',
            '}',
          ].join('\n'),
        ),
      });

      const proxyCommon = {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Everything the viewer sent except Host, which has to stay PostHog's own
        // or their router cannot tell what the request is for. The managed
        // CORS policies forward no query string, and PostHog puts the batch
        // compression and the API version in the query string.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          { function: stripPrefix, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
        compress: true,
      };

      const assetBehavior = {
        ...proxyCommon,
        origin: new origins.HttpOrigin(analytics.assets, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // Honours whatever PostHog says: zero default TTL, so a response with no
        // cache-control is re-fetched, and one with it is kept for as long as it
        // asks up to a day. This is the whole reason /array/* is not pointed at
        // the ingestion origin — that one strips the cache headers, and stale
        // remote config silently freezes the recorder's settings.
        cachePolicy: new cloudfront.CachePolicy(this, 'AnalyticsAssetCache', {
          comment: 'PostHog assets: cache as the origin instructs',
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Origin'),
          cookieBehavior: cloudfront.CacheCookieBehavior.none(),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
          minTtl: Duration.seconds(0),
          defaultTtl: Duration.seconds(0),
          maxTtl: Duration.days(1),
        }),
      };

      // Order is load-bearing: CloudFront tries path patterns in the order they
      // are declared, so the two asset paths have to come before the catch-all or
      // it would swallow them and serve the SDK from the ingestion host.
      proxyBehaviors[`${PROXY_PATH}/static/*`] = assetBehavior;
      proxyBehaviors[`${PROXY_PATH}/array/*`] = assetBehavior;
      proxyBehaviors[`${PROXY_PATH}/*`] = {
        ...proxyCommon,
        origin: new origins.HttpOrigin(analytics.api, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        // POST is not optional here: every event, and every session replay
        // snapshot, is a POST body.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Ingestion must never be cached, and neither must a feature flag call.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      };
    }

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
      // The analytics proxy, or nothing at all when no key is configured. These
      // carry no response headers policy of their own: PostHog answers with its
      // own CORS headers and its own cache directives, and the site's policy has
      // nothing useful to say about a JSON API response.
      additionalBehaviors: proxyBehaviors,
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
        //
        // Distribution-wide, which CloudFront gives no way to scope to one
        // behaviour, so an error *from PostHog* also comes back as this page.
        // Harmless in practice — ingestion answers 200, and the SDK treats a
        // non-2xx as a failed batch either way — but it is why a debugging
        // session against the proxy sees HTML where it expected JSON.
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
