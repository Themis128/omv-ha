export declare const SSH_CONFIG: {
    readonly "omv-ha": {
        readonly host: string;
        readonly port: number;
        readonly username: string;
        readonly privateKeyPath: string;
    };
    readonly "omv-main": {
        readonly host: string;
        readonly port: number;
        readonly username: string;
        readonly privateKeyPath: string;
    };
};
export type NodeName = keyof typeof SSH_CONFIG;
export declare const AWS_REGION: string;
export declare const AWS_ACCOUNT_ID = "278585680617";
export declare const SSM_PREFIX: string;
export declare const ROUTE53_ZONE_ID = "Z079608614L53CC4EAZM3";
export declare const PRIMARY_HEALTH_CHECK_ID = "e239ad5c-dd17-40d7-8045-a153715168cf";
export declare const SECONDARY_HEALTH_CHECK_ID = "30a69f1c-8d48-49bd-9067-cabec979478b";
export declare const CLOUDFRONT_APEX = "d3k7muo3c6lw6s.cloudfront.net";
export declare const CLOUDFRONT_WWW = "dgrxxatzrgxfi.cloudfront.net";
export declare const APIGW_ID = "dwtp9xt4dd";
export declare const APIGW_APEX_DOMAIN = "d-uy6dmk95il.execute-api.us-east-1.amazonaws.com";
export declare const APIGW_WWW_DOMAIN = "d-2msx2z5q7d.execute-api.us-east-1.amazonaws.com";
export declare const LAMBDA_LOG_GROUP_PREFIX = "/aws/lambda/cloudless-";
export declare const PI_SECONDARY_PORT = 18443;
export declare const CHARACTER_LIMIT = 20000;
export declare const CLOUDFLARE_API_TOKEN: string;
export declare const CLOUDFLARE_ZONE_ID: string;
export declare const CLOUDFLARE_TUNNEL_ID = "a82f24a8-f767-4a59-bc77-1d59ad132be2";
