import { homedir } from "os";
import { join } from "path";
// ---------------------------------------------------------------------------
// Pi node SSH config — override via env vars if needed
// ---------------------------------------------------------------------------
export const SSH_CONFIG = {
    "omv-ha": {
        host: process.env.OMV_HA_HOST ?? "192.168.1.130",
        port: Number(process.env.PI_SSH_PORT ?? 22),
        username: process.env.PI_SSH_USER ?? "tbaltzakis",
        privateKeyPath: process.env.PI_SSH_KEY_PATH ?? join(homedir(), ".ssh", "id_ed25519"),
    },
    "omv-main": {
        host: process.env.OMV_MAIN_HOST ?? "192.168.1.128",
        port: Number(process.env.PI_SSH_PORT ?? 22),
        username: process.env.PI_SSH_USER ?? "tbaltzakis",
        privateKeyPath: process.env.PI_SSH_KEY_PATH ?? join(homedir(), ".ssh", "id_ed25519"),
    },
};
// ---------------------------------------------------------------------------
// AWS identifiers (non-secret, safe to hardcode)
// ---------------------------------------------------------------------------
export const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
export const AWS_ACCOUNT_ID = "278585680617";
export const SSM_PREFIX = process.env.SSM_PREFIX ?? "/cloudless/production";
// Route 53
export const ROUTE53_ZONE_ID = "Z079608614L53CC4EAZM3";
export const PRIMARY_HEALTH_CHECK_ID = "e239ad5c-dd17-40d7-8045-a153715168cf";
export const SECONDARY_HEALTH_CHECK_ID = "30a69f1c-8d48-49bd-9067-cabec979478b";
// CloudFront distributions
export const CLOUDFRONT_APEX = "d3k7muo3c6lw6s.cloudfront.net";
export const CLOUDFRONT_WWW = "dgrxxatzrgxfi.cloudfront.net";
export const CLOUDFRONT_DISTRIBUTION_ID = "ELGQBR8109MTM";
export const CLOUDFRONT_ORIGIN_GROUP_ID = "primary-with-ha";
// HA failover — Tailscale Funnel (CloudFront secondary origin)
export const TAILSCALE_FUNNEL_HOST = "omv.tail8eb71.ts.net";
export const K3S_TRAEFIK_VIP = "192.168.1.200";
// API Gateway (Pi failover secondary path) — RETIRED 2026-05-23
// Both APIGW custom domains were deleted; Route 53 SECONDARY records removed.
// HA failover is now handled by CloudFront origin groups.
export const APIGW_ID = "dwtp9xt4dd"; // kept for reference only
export const APIGW_APEX_DOMAIN = "d-uy6dmk95il.execute-api.us-east-1.amazonaws.com"; // NXDomain — deleted
export const APIGW_WWW_DOMAIN = "d-2msx2z5q7d.execute-api.us-east-1.amazonaws.com"; // NXDomain — deleted
// Lambda function name prefix (SST names it <stack>-<stage>-...)
export const LAMBDA_LOG_GROUP_PREFIX = "/aws/lambda/cloudless-";
// cloudless.gr secondary server port on the Pi
export const PI_SECONDARY_PORT = 18443;
// Max characters to return in a single tool response
export const CHARACTER_LIMIT = 20000;
// ---------------------------------------------------------------------------
// Cloudflare — cloudless.gr zone
// ---------------------------------------------------------------------------
export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "fb7dc7b69b662480cd5961a4d1913c78";
export const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? ""; // TODO: set to cloudless.gr zone ID
export const CLOUDFLARE_TUNNEL_ID = "a82f24a8-f767-4a59-bc77-1d59ad132be2";
//# sourceMappingURL=constants.js.map