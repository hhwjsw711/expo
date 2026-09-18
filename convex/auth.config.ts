import { AuthConfig } from "convex/server";

// Custom JWT auth provider for Wordream.
// - The PRIVATE key (JWT_PRIVATE_KEY env var on Convex, dev only) signs JWTs
//   in convex/auth.ts. It never enters git.
// - The PUBLIC key below is embedded as a data-URI JWKS so Convex can verify
//   signatures without any external fetch.
// Rotating keys: replace JWT_PRIVATE_KEY env var AND this public JWK together.

const jwksDataUri = "data:application/json;base64,eyJrZXlzIjpbeyJrdHkiOiJSU0EiLCJuIjoieVFkRml1ZzZtRW1meVAwdDE1MWRFN3c2Z2tmUXpPNXJyaXdzQmp1SElMTUd0c0JXWDhtbFdLOUhTN29jQ3ppZlFQZWdHazlnc3M3b2R2Q3dBR3V4alc0U3JuZnhldWx5ME4yWnhiLWE3RUsxa3VISW4tUXFkZmlkcXNiZ2h1dHl6Y2RWa0xwNkhaeFBvZHMzOENnTDhHc2lhbHhTQUV3VVlRN1dKcU1EekN5OTFtRmR5eHJsQzFQcjRLalNWaXMxQ0htT1J5Z0FpS1J3MzZ6UUxxTVdxeU5ZOGcwbkdhakcxV0FPLUFxNGdzU2liNkd6a3VyV1hUaEMxRFJDcGh2TFJQanZ2VzR6WG9mRlo4ekwyYnpYZDBEaV9ZS0VFc3M5dEZlV0lxajdqVVI2U2RIOHNjc3RVU3lqMXAwYTc0aTBDSF9pZTc4bkxNblExX1hDbzlBT2RRIiwiZSI6IkFRQUIiLCJraWQiOiJ3b3JkcmVhbS1qd3QtMjAyNi0wOSIsImFsZyI6IlJTMjU2IiwidXNlIjoic2lnIn1dfQ==";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "wordream-app",
      issuer: "https://wordream.convex.cloud",
      jwks: jwksDataUri,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
